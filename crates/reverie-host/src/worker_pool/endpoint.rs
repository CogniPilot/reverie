//! Fixed service-v2 endpoint and original delegated broker peer. This is local
//! channel custody only: no activation, member write or maintenance grant.
use super::*;
use crate::native::{self, socket_entry::SocketEntry};
use std::{
    cell::Cell,
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
#[cfg(test)]
mod tests;
#[derive(Clone, Copy, Eq, PartialEq)]
enum Stage {
    Opening,
    Listening,
    PeerIssued,
    Refused,
    Closing,
    Closed,
}
#[derive(Clone, Copy, Eq, PartialEq)]
enum PeerSettlement {
    Unissued,
    Held,
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
    peer: Cell<PeerSettlement>,
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
            peer: Cell::new(PeerSettlement::Unissued),
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
        let allowed = self.stage == Stage::Listening && self.peer.get() == PeerSettlement::Unissued;
        if allowed {
            self.stage = Stage::PeerIssued;
            self.peer.set(PeerSettlement::Held);
        }
        let mut peer = ControllerPeer {
            endpoint: self,
            native: PeerNative {
                stream: None,
                pidfd: None,
                closed: false,
                close_unknown: false,
                completion: allowed.then_some(&self.peer),
            },
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
        // A dropped peer retains its descriptors and this SAME slot. Preserve
        // the bound name/listener as well; local endpoint teardown cannot hide
        // an abandoned original connection or authorize a new bind.
        require_peer_settled(&self.peer)?;
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
    native: PeerNative<'endpoint>,
}
struct PeerNative<'endpoint> {
    stream: Option<UnixStream>,
    pidfd: Option<OwnedFd>,
    closed: bool,
    close_unknown: bool,
    completion: Option<&'endpoint Cell<PeerSettlement>>,
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
                    self.native.stream = Some(stream);
                    break;
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(1))
                }
                Err(error) => return Err(error.into()),
            }
        }
        let stream = self
            .native
            .stream
            .as_ref()
            .expect("stored before native qualification");
        stream.set_nonblocking(true)?;
        nix::sys::socket::setsockopt(stream, nix::sys::socket::sockopt::PassCred, &true)
            .map_err(io::Error::from)?;
        self.native.pidfd = Some(
            nix::sys::socket::getsockopt(stream, nix::sys::socket::sockopt::PeerPidfd)
                .map_err(io::Error::from)?,
        );
        self.require_original_broker()
    }
    /// Uses delegated ORIGINAL code qualification, exact kernel peer and live
    /// PIDFD. It deliberately does not inspect a foreign UID's exe/root/ns.
    pub fn require_original_broker(&mut self) -> Result<()> {
        need(
            !self.native.closed && !self.native.close_unknown,
            "WORKER_POOL_CONTROL_CLOSED",
        )?;
        let expected = match self.endpoint.policy.broker_birth() {
            Ok(expected) => expected,
            Err(error) => {
                self.native.close_unknown |= error.close_unknown();
                return Err(error);
            }
        };
        let stream = self
            .native
            .stream
            .as_ref()
            .ok_or(PoolError::Refused("WORKER_POOL_BROKER_PEER_UNKNOWN"))?;
        let pidfd = self
            .native
            .pidfd
            .as_ref()
            .ok_or(PoolError::Refused("WORKER_POOL_BROKER_PIDFD_UNKNOWN"))?;
        verify_peer(stream, pidfd, expected, &mut self.native.close_unknown)
    }
    pub fn close(&mut self) -> Result<()> {
        self.native.close()
    }
}
impl PeerNative<'_> {
    fn close(&mut self) -> Result<()> {
        self.closed = true;
        close_peer(&mut self.stream, &mut self.pidfd, &mut self.close_unknown)?;
        if let Some(completion) = self.completion {
            need(
                completion.get() != PeerSettlement::Unissued,
                "WORKER_POOL_CONTROL_PEER_UNISSUED",
            )?;
            completion.set(PeerSettlement::Closed);
        }
        Ok(())
    }
}
fn verify_peer(
    stream: &UnixStream,
    pidfd: &OwnedFd,
    expected: &reverie_contracts::worker_pool::BrokerBirthData,
    close_unknown: &mut bool,
) -> Result<()> {
    need(!*close_unknown, "WORKER_POOL_CONTROL_CLOSE_UNKNOWN")?;
    let body = inspect_peer(stream, pidfd, expected);
    *close_unknown |= body.as_ref().is_err_and(PoolError::close_unknown);
    body
}
fn inspect_peer(
    stream: &UnixStream,
    pidfd: &OwnedFd,
    expected: &reverie_contracts::worker_pool::BrokerBirthData,
) -> Result<()> {
    let peer = nix::sys::socket::getsockopt(stream, nix::sys::socket::sockopt::PeerCredentials)
        .map_err(io::Error::from)?;
    need(
        peer.pid() as u32 == expected.pid() && [peer.uid(), peer.gid()] == expected.ids(),
        "WORKER_POOL_BROKER_PEER_CHANGED",
    )?;
    need(
        super::directory::process_start(expected.pid())? == expected.start(),
        "WORKER_POOL_BROKER_INCARNATION_CHANGED",
    )?;
    use std::os::fd::AsFd;
    let mut ready = [nix::poll::PollFd::new(
        pidfd.as_fd(),
        nix::poll::PollFlags::POLLIN,
    )];
    need(
        nix::poll::poll(&mut ready, nix::poll::PollTimeout::ZERO).map_err(io::Error::from)? == 0,
        "WORKER_POOL_BROKER_ENDED",
    )
}
fn close_peer(
    stream: &mut Option<UnixStream>,
    pidfd: &mut Option<OwnedFd>,
    close_unknown: &mut bool,
) -> Result<()> {
    let stream = stream
        .take()
        .map(|stream| native::close(File::from(OwnedFd::from(stream))))
        .transpose()
        .map(|_| ())
        .map_err(Into::into);
    let pidfd = pidfd
        .take()
        .map(|fd| native::close(File::from(fd)))
        .transpose()
        .map(|_| ())
        .map_err(Into::into);
    let body = finalized(stream, pidfd);
    *close_unknown |= body.is_err();
    body?;
    need(!*close_unknown, "WORKER_POOL_CONTROL_CLOSE_UNKNOWN")
}
impl Drop for PeerNative<'_> {
    fn drop(&mut self) {
        std::mem::forget(self.stream.take());
        std::mem::forget(self.pidfd.take());
    }
}
fn require_peer_settled(peer: &Cell<PeerSettlement>) -> Result<()> {
    need(
        peer.get() != PeerSettlement::Held,
        "WORKER_POOL_CONTROL_PEER_RETAINED",
    )
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
