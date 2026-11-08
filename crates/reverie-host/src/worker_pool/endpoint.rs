//! Fixed service-v2 endpoint and original delegated broker peer. This is local
//! channel custody only: no activation, member write or maintenance grant.
use super::*;
use crate::native::{self, socket_entry::SocketEntry};
use std::{
    fs::{self, File},
    os::{
        fd::{AsRawFd, OwnedFd},
        unix::{
            fs::MetadataExt,
            net::{UnixListener, UnixStream},
        },
    },
    path::PathBuf,
    time::{Duration, Instant},
};

const DIRECTORY: &str = "/run/reverie-worker-pool/control";
const LEAF: &str = "controller.sock";
#[derive(Clone, Copy, Eq, PartialEq)]
enum Stage {
    Opening,
    Listening,
    PeerIssued,
    Refused,
    Closing,
    Closed,
}

#[must_use = "retain the endpoint and its partial owners on uncertain finalization"]
pub struct ControllerEndpoint<'policy> {
    policy: &'policy ControllerPoolPolicy,
    directory: Option<File>,
    listener: Option<UnixListener>,
    entry: Option<SocketEntry>,
    stage: Stage,
    close_unknown: bool,
}
impl<'policy> ControllerEndpoint<'policy> {
    pub fn bind_service_v2(
        policy: &'policy ControllerPoolPolicy,
    ) -> std::result::Result<Self, Box<ControllerEndpointFailure<'policy>>> {
        let mut owner = Self {
            policy,
            directory: None,
            listener: None,
            entry: None,
            stage: Stage::Opening,
            close_unknown: false,
        };
        match owner.bind() {
            Ok(()) => {
                owner.stage = Stage::Listening;
                Ok(owner)
            }
            Err(primary) => {
                owner.close_unknown |= primary.close_unknown();
                owner.stage = Stage::Refused;
                Err(Box::new(ControllerEndpointFailure { owner, primary }))
            }
        }
    }
    fn bind(&mut self) -> Result<()> {
        self.policy.broker_birth()?;
        self.directory = Some(native::open_at(
            libc::AT_FDCWD,
            std::ffi::OsStr::new(DIRECTORY),
            libc::O_RDONLY | libc::O_DIRECTORY,
        )?);
        let directory = self.directory.as_ref().expect("stored before validation");
        let info = directory.metadata()?;
        let policy = self.policy.data();
        need(
            info.is_dir()
                && info.uid() == policy.broker_uid
                && info.gid() == policy.broker_gid
                && info.mode() & 0o7777 == 0o770,
            "WORKER_POOL_CONTROL_DIRECTORY_CUSTODY",
        )?;
        let flags = nix::sys::statvfs::fstatvfs(directory).map_err(io::Error::from)?;
        need(
            !flags
                .flags()
                .contains(nix::sys::statvfs::FsFlags::ST_RDONLY),
            "WORKER_POOL_CONTROL_DIRECTORY_READONLY",
        )?;
        // Derive the endpoint from the actual opened parent FD. Rebinding the
        // mount pathname cannot redirect this bind or later inode cleanup.
        let path = PathBuf::from(format!("/proc/self/fd/{}/{LEAF}", directory.as_raw_fd()));
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => (),
            _ => return Err(PoolError::Refused("WORKER_POOL_CONTROL_ENDPOINT_EXISTS")),
        }
        self.listener = Some(UnixListener::bind(&path)?);
        self.entry = Some(SocketEntry::created(path));
        let entry = self.entry.as_mut().expect("actual newly bound socket");
        entry.open_anchor().map_err(socket_error)?;
        entry
            .finish_controller_pin(policy.broker_gid)
            .map_err(socket_error)?;
        self.listener
            .as_ref()
            .expect("retained listener")
            .set_nonblocking(true)?;
        self.policy.broker_birth()?;
        Ok(())
    }
    /// One actual original broker channel for this serving scope. The borrow
    /// prevents endpoint closure while either the peer or partial failure lives.
    pub fn accept_original_broker(
        &mut self,
        end: Instant,
    ) -> std::result::Result<ControllerPeer<'_>, Box<ControllerPeerFailure<'_>>> {
        let allowed = self.stage == Stage::Listening;
        if allowed {
            self.stage = Stage::PeerIssued;
        }
        let mut peer = ControllerPeer {
            endpoint: self,
            stream: None,
            pidfd: None,
            closed: false,
            close_unknown: false,
        };
        let body = need(allowed, "WORKER_POOL_CONTROL_ACCEPT_ALREADY_ATTEMPTED")
            .and_then(|()| peer.accept(end));
        match body {
            Ok(()) => Ok(peer),
            Err(primary) => Err(Box::new(ControllerPeerFailure {
                owner: peer,
                primary,
            })),
        }
    }
    /// Metadata/socket closure only. It closes no worker, pool or maintenance
    /// operation, and never acknowledges a broker handler or lease release.
    pub fn close(&mut self) -> Result<()> {
        self.stage = Stage::Closing;
        let listener = self
            .listener
            .take()
            .map(|listener| native::close(File::from(OwnedFd::from(listener))).map_err(Into::into))
            .unwrap_or(Ok(()));
        let entry = self
            .entry
            .as_mut()
            .map_or(Ok(()), |entry| entry.remove().map_err(socket_error));
        // Keep the actual parent FD while the anchored socket name is not
        // known removed; its /proc/self/fd path must remain usable for cleanup.
        let directory = if entry.is_ok() {
            self.directory
                .take()
                .map(native::close)
                .transpose()
                .map(|_| ())
                .map_err(Into::into)
        } else {
            Ok(())
        };
        let body = finalized(finalized(listener, entry), directory);
        self.close_unknown |= body.is_err();
        body?;
        need(!self.close_unknown, "WORKER_POOL_CONTROL_CLOSE_UNKNOWN")?;
        self.stage = Stage::Closed;
        Ok(())
    }
}
impl Drop for ControllerEndpoint<'_> {
    fn drop(&mut self) {
        if self.stage != Stage::Closed {
            std::mem::forget(self.listener.take());
            std::mem::forget(self.entry.take());
            std::mem::forget(self.directory.take());
        }
    }
}
pub struct ControllerEndpointFailure<'policy> {
    owner: ControllerEndpoint<'policy>,
    primary: PoolError,
}
impl ControllerEndpointFailure<'_> {
    pub fn primary_error(&self) -> &PoolError {
        &self.primary
    }
    pub fn close(&mut self) -> Result<()> {
        self.owner.close()
    }
}

#[must_use = "retain this original socket and PIDFD after uncertain close"]
pub struct ControllerPeer<'endpoint> {
    endpoint: &'endpoint ControllerEndpoint<'endpoint>,
    stream: Option<UnixStream>,
    pidfd: Option<OwnedFd>,
    closed: bool,
    close_unknown: bool,
}
impl ControllerPeer<'_> {
    fn accept(&mut self, end: Instant) -> Result<()> {
        self.endpoint.policy.broker_birth()?;
        loop {
            need(Instant::now() < end, "WORKER_POOL_CONTROL_ACCEPT_DEADLINE")?;
            match self
                .endpoint
                .listener
                .as_ref()
                .ok_or(PoolError::Refused("WORKER_POOL_CONTROL_CLOSED"))?
                .accept()
            {
                Ok((stream, _)) => {
                    self.stream = Some(stream);
                    break;
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(1))
                }
                Err(error) => return Err(error.into()),
            }
        }
        let stream = self
            .stream
            .as_ref()
            .expect("stored before native qualification");
        stream.set_nonblocking(true)?;
        nix::sys::socket::setsockopt(stream, nix::sys::socket::sockopt::PassCred, &true)
            .map_err(io::Error::from)?;
        self.pidfd = Some(
            nix::sys::socket::getsockopt(stream, nix::sys::socket::sockopt::PeerPidfd)
                .map_err(io::Error::from)?,
        );
        self.require_original_broker()
    }
    /// Uses delegated ORIGINAL code qualification, exact kernel peer and live
    /// PIDFD. It deliberately does not inspect a foreign UID's exe/root/ns.
    pub fn require_original_broker(&self) -> Result<()> {
        need(
            !self.closed && !self.close_unknown,
            "WORKER_POOL_CONTROL_CLOSED",
        )?;
        let expected = self.endpoint.policy.broker_birth()?;
        let stream = self
            .stream
            .as_ref()
            .ok_or(PoolError::Refused("WORKER_POOL_BROKER_PEER_UNKNOWN"))?;
        let peer = nix::sys::socket::getsockopt(stream, nix::sys::socket::sockopt::PeerCredentials)
            .map_err(io::Error::from)?;
        need(
            peer.pid() as u32 == expected.pid() && [peer.uid(), peer.gid()] == expected.ids(),
            "WORKER_POOL_BROKER_PEER_CHANGED",
        )?;
        let start = super::directory::process_start(expected.pid())?;
        need(
            start == expected.start(),
            "WORKER_POOL_BROKER_INCARNATION_CHANGED",
        )?;
        let pidfd = self
            .pidfd
            .as_ref()
            .ok_or(PoolError::Refused("WORKER_POOL_BROKER_PIDFD_UNKNOWN"))?;
        use std::os::fd::AsFd;
        let mut ready = [nix::poll::PollFd::new(
            pidfd.as_fd(),
            nix::poll::PollFlags::POLLIN,
        )];
        need(
            nix::poll::poll(&mut ready, nix::poll::PollTimeout::ZERO).map_err(io::Error::from)?
                == 0,
            "WORKER_POOL_BROKER_ENDED",
        )?;
        Ok(())
    }
    pub fn close(&mut self) -> Result<()> {
        self.closed = true;
        let stream = self
            .stream
            .take()
            .map(|stream| native::close(File::from(OwnedFd::from(stream))))
            .transpose()
            .map(|_| ())
            .map_err(Into::into);
        let pidfd = self
            .pidfd
            .take()
            .map(|fd| native::close(File::from(fd)))
            .transpose()
            .map(|_| ())
            .map_err(Into::into);
        let body = finalized(stream, pidfd);
        self.close_unknown |= body.is_err();
        body?;
        need(!self.close_unknown, "WORKER_POOL_CONTROL_CLOSE_UNKNOWN")
    }
}
impl Drop for ControllerPeer<'_> {
    fn drop(&mut self) {
        std::mem::forget(self.stream.take());
        std::mem::forget(self.pidfd.take());
    }
}
pub struct ControllerPeerFailure<'endpoint> {
    owner: ControllerPeer<'endpoint>,
    primary: PoolError,
}
impl ControllerPeerFailure<'_> {
    pub fn primary_error(&self) -> &PoolError {
        &self.primary
    }
    pub fn close(&mut self) -> Result<()> {
        self.owner.close()
    }
}
fn socket_error(error: crate::native::socket_entry::SocketError) -> PoolError {
    use crate::native::socket_entry::SocketError;
    match error {
        SocketError::Io(error) => error.into(),
        SocketError::Unconfirmed => PoolError::Refused("WORKER_POOL_CONTROL_SOCKET_UNCONFIRMED"),
        SocketError::Finalization { primary, secondary } => PoolError::Finalization(
            Box::new(socket_error(*primary)),
            Box::new(socket_error(*secondary)),
        ),
    }
}
