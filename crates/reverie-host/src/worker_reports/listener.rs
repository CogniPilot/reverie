//! Fixed configured broker listener. Registration uses the existing Record
//! inventory; neither a second connection cap nor a raw stream is exported.
use super::*;
use crate::native::socket_entry::{SocketEntry, SocketError};
use nix::sys::socket::{AddressFamily, Backlog, SockFlag, SockType, UnixAddr};
use reverie_contracts::worker_schema::{WorkerEnvelope, WorkerPath};
use reverie_core::worker_schema::WorkerServiceIdentity;
use std::{
    fs::{self, File},
    io,
    os::{
        fd::{AsFd, AsRawFd, OwnedFd},
        unix::{
            fs::{FileTypeExt, MetadataExt},
            net::UnixListener,
        },
    },
    path::PathBuf,
};
#[derive(Debug)]
pub enum BrokerListenerError {
    Refused(&'static str),
    Io(io::Error),
    Report(WorkerReportError),
    Unconfirmed,
    Finalization {
        primary: Box<Self>,
        secondary: Box<Self>,
    },
}
impl std::fmt::Display for BrokerListenerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Refused(code) => f.write_str(code),
            Self::Io(error) => error.fmt(f),
            Self::Report(error) => error.fmt(f),
            Self::Unconfirmed => f.write_str("WORKER_LISTENER_CLOSE_UNCONFIRMED"),
            Self::Finalization { primary, secondary } => {
                write!(f, "{primary}; additional cleanup: {secondary}")
            }
        }
    }
}
impl std::error::Error for BrokerListenerError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Report(error) => Some(error),
            Self::Finalization { primary, .. } => Some(primary.as_ref()),
            _ => None,
        }
    }
}
impl From<io::Error> for BrokerListenerError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}
type ListenResult<T> = std::result::Result<T, BrokerListenerError>;
fn finalized<T>(result: ListenResult<T>, closed: ListenResult<()>) -> ListenResult<T> {
    match (result, closed) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(primary), Err(secondary)) => Err(BrokerListenerError::Finalization {
            primary: Box::new(primary),
            secondary: Box::new(secondary),
        }),
    }
}
fn socket_error(error: SocketError) -> BrokerListenerError {
    match error {
        SocketError::Io(error) => BrokerListenerError::Io(error),
        SocketError::Unconfirmed => BrokerListenerError::Unconfirmed,
        SocketError::Finalization { primary, secondary } => BrokerListenerError::Finalization {
            primary: Box::new(socket_error(*primary)),
            secondary: Box::new(socket_error(*secondary)),
        },
    }
}
enum Leaf {
    Observed(SocketEntry),
    Created(SocketEntry),
}
struct Resources {
    engine: Arc<InstalledWorkerEngine>,
    path: PathBuf,
    socket: Option<OwnedFd>,
    listener: Option<UnixListener>,
    leaf: Option<Leaf>,
    opaque: bool,
    closed: bool,
}
#[must_use = "retain prepared socket custody through recovery and actual bind"]
pub struct PreparedBrokerListener {
    resources: Resources,
}
#[must_use = "close the actual listener and its pinned filesystem entry"]
pub struct WorkerBrokerListener {
    resources: Resources,
}
#[must_use = "retain failed listener construction and check its real cleanup"]
pub struct BrokerListenerFailure {
    cause: BrokerListenerError,
    resources: Resources,
}
impl std::fmt::Debug for BrokerListenerFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BrokerListenerFailure")
            .field("cause", &self.cause)
            .finish_non_exhaustive()
    }
}
impl BrokerListenerFailure {
    pub fn cause(&self) -> &BrokerListenerError {
        &self.cause
    }
    pub fn close(&mut self) -> ListenResult<()> {
        self.resources.close()
    }
}
impl std::fmt::Display for BrokerListenerFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.cause.fmt(f)
    }
}
impl std::error::Error for BrokerListenerFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.cause)
    }
}
impl WorkerRuntime {
    /// Actual App startup supplies its captured envelope, before recovery.
    /// Binding/listening is a later consuming transition after real recovery.
    pub fn prepare_broker_listener(
        &self,
        envelope: &WorkerEnvelope,
    ) -> std::result::Result<PreparedBrokerListener, Box<BrokerListenerFailure>> {
        let mut resources = Resources {
            engine: self.installed_engine().clone(),
            path: PathBuf::new(),
            socket: None,
            listener: None,
            leaf: None,
            opaque: false,
            closed: false,
        };
        let result = (|| {
            if WorkerServiceIdentity::capture(envelope.base()) != *self.worker_identity() {
                return Err(BrokerListenerError::Refused(
                    "WORKER_LISTENER_RUNTIME_CHANGED",
                ));
            }
            resources.path =
                crate::native::python_path(envelope.path(WorkerPath::Socket).codepoints())?;
            resources.prepare()
        })();
        match result {
            Ok(()) => Ok(PreparedBrokerListener { resources }),
            Err(cause) => Err(Box::new(BrokerListenerFailure { cause, resources })),
        }
    }
}
impl Resources {
    fn running(&self) -> ListenResult<()> {
        if self.closed || self.opaque {
            return Err(BrokerListenerError::Unconfirmed);
        }
        if self.engine.cancellation().is_cancelled() {
            Err(BrokerListenerError::Refused("Worker broker is stopping"))
        } else {
            Ok(())
        }
    }
    fn prepare(&mut self) -> ListenResult<()> {
        self.running()?;
        let parent = self.path.parent().ok_or(BrokerListenerError::Refused(
            "Worker socket directory must be owner-only",
        ))?;
        // Preserve the original raw parent creation/leaf check, including its
        // ancestor semantics; Office's stricter directory policy stays separate.
        crate::native::worker_directory::create_worker_private(parent)?;
        let metadata = fs::symlink_metadata(parent)?;
        if !metadata.is_dir()
            || metadata.uid() != crate::native::uid()
            || metadata.mode() & 0o077 != 0
        {
            return Err(BrokerListenerError::Refused(
                "Worker socket directory must be owner-only",
            ));
        }
        match fs::symlink_metadata(&self.path) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
            Ok(info) if !info.file_type().is_socket() => Err(BrokerListenerError::Refused(
                "Refusing to replace a non-socket",
            )),
            Ok(_) => self.probe(),
        }
    }
    fn probe(&mut self) -> ListenResult<()> {
        self.leaf = Some(Leaf::Observed(SocketEntry::observed(self.path.clone())));
        let Some(Leaf::Observed(entry)) = self.leaf.as_mut() else {
            unreachable!()
        };
        entry.open_anchor().map_err(socket_error)?;
        entry.pin_identity().map_err(socket_error)?;
        self.socket = Some(new_socket()?);
        let address = UnixAddr::new(&self.path).map_err(io::Error::from)?;
        let fd = self.socket.as_ref().expect("actual probe owner");
        let connected = nix::sys::socket::connect(fd.as_raw_fd(), &address);
        let result = match connected {
            Err(nix::errno::Errno::ECONNREFUSED) => entry.remove_stale().map_err(socket_error),
            Ok(()) => Err(BrokerListenerError::Refused(
                "Another worker broker is already listening",
            )),
            Err(error) => Err(io::Error::from(error).into()),
        };
        let result = finalized(result, self.close_socket());
        // On any live/in-progress/full-backlog result the observed name is
        // preserved; only same-inode ECONNREFUSED chooses stale removal.
        finalized(
            result,
            match self.leaf.as_mut() {
                Some(Leaf::Observed(entry)) => entry.preserve_name().map_err(socket_error),
                _ => Ok(()),
            },
        )
    }
    fn bind(&mut self) -> ListenResult<()> {
        self.running()?;
        self.socket = Some(new_socket()?);
        let address = UnixAddr::new(&self.path).map_err(io::Error::from)?;
        let socket = self.socket.as_ref().expect("actual listener constructor");
        nix::sys::socket::bind(socket.as_raw_fd(), &address).map_err(io::Error::from)?;
        self.leaf = Some(Leaf::Created(SocketEntry::created(self.path.clone())));
        let Some(Leaf::Created(entry)) = self.leaf.as_mut() else {
            unreachable!()
        };
        entry.open_anchor().map_err(socket_error)?;
        entry.finish_pin().map_err(socket_error)?;
        nix::sys::socket::listen(socket, Backlog::new(8).map_err(io::Error::from)?)
            .map_err(io::Error::from)?;
        self.listener = Some(UnixListener::from(
            self.socket.take().expect("same owned listening socket"),
        ));
        Ok(())
    }
    fn close_socket(&mut self) -> ListenResult<()> {
        let closed = self.socket.take().map_or(Ok(()), |fd| {
            crate::native::close(File::from(fd)).map_err(|_| BrokerListenerError::Unconfirmed)
        });
        if closed.is_err() {
            self.opaque = true;
        }
        closed
    }
    fn close(&mut self) -> ListenResult<()> {
        if self.closed {
            return Ok(());
        }
        let socket = self.close_socket();
        let listener = self.listener.take().map_or(Ok(()), |listener| {
            let fd: OwnedFd = listener.into();
            crate::native::close(File::from(fd)).map_err(|_| BrokerListenerError::Unconfirmed)
        });
        let leaf = match self.leaf.as_mut() {
            Some(Leaf::Observed(entry)) => entry.preserve_name().map_err(socket_error),
            Some(Leaf::Created(entry)) => entry.remove().map_err(socket_error),
            None => Ok(()),
        };
        let result = finalized(finalized(socket, listener), leaf);
        self.opaque |= result.is_err();
        if self.opaque {
            return finalized(result, Err(BrokerListenerError::Unconfirmed));
        }
        self.closed = true;
        Ok(())
    }
}
fn new_socket() -> ListenResult<OwnedFd> {
    nix::sys::socket::socket(
        AddressFamily::Unix,
        SockType::Stream,
        SockFlag::SOCK_CLOEXEC | SockFlag::SOCK_NONBLOCK,
        None,
    )
    .map_err(|error| io::Error::from(error).into())
}
impl PreparedBrokerListener {
    pub fn bind(mut self) -> std::result::Result<WorkerBrokerListener, Box<BrokerListenerFailure>> {
        match self.resources.bind() {
            Ok(()) => Ok(WorkerBrokerListener {
                resources: self.resources,
            }),
            Err(cause) => Err(Box::new(BrokerListenerFailure {
                cause,
                resources: self.resources,
            })),
        }
    }
    pub fn close(&mut self) -> ListenResult<()> {
        self.resources.close()
    }
}
impl WorkerBrokerListener {
    /// Only the same captured service receives the accepted stream. Kernel UID
    /// and payload handling remain in the original registered reader/handler.
    pub fn accept(
        &self,
        service: &Arc<WorkerReportService>,
    ) -> ListenResult<Option<RegisteredWorkerConnection>> {
        if !Arc::ptr_eq(&self.resources.engine, &service.engine) {
            return Err(BrokerListenerError::Refused(
                "WORKER_LISTENER_RUNTIME_CHANGED",
            ));
        }
        self.resources.running()?;
        let listener = self
            .resources
            .listener
            .as_ref()
            .ok_or(BrokerListenerError::Unconfirmed)?;
        let mut poll = [nix::poll::PollFd::new(
            listener.as_fd(),
            nix::poll::PollFlags::POLLIN,
        )];
        match nix::poll::poll(&mut poll, 500u16) {
            Ok(0) | Err(nix::errno::Errno::EINTR) => return Ok(None),
            Ok(_) => (),
            Err(error) => return Err(io::Error::from(error).into()),
        }
        self.resources.running()?;
        match listener.accept() {
            Ok((stream, _)) => match service.register_worker_connection(stream) {
                Ok(connection) => Ok(Some(connection)),
                // The original rejected socket is already known closed.
                // A close failure is Finalization, never this bare known refusal.
                Err(WorkerReportError::Capacity) => {
                    eprintln!("{}", WorkerReportError::Capacity);
                    Ok(None)
                }
                Err(error) => Err(BrokerListenerError::Report(error)),
            },
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => Ok(None),
            Err(error) => Err(error.into()),
        }
    }
    pub fn close(&mut self) -> ListenResult<()> {
        self.resources.close()
    }
}
impl Drop for Resources {
    fn drop(&mut self) {
        if self.close().is_ok() {
            return;
        }
        type Abandoned = (
            Arc<InstalledWorkerEngine>,
            Option<OwnedFd>,
            Option<UnixListener>,
            Option<Leaf>,
        );
        static ABANDONED: OnceLock<Mutex<Vec<Abandoned>>> = OnceLock::new();
        ABANDONED
            .get_or_init(|| Mutex::new(Vec::new()))
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push((
                self.engine.clone(),
                self.socket.take(),
                self.listener.take(),
                self.leaf.take(),
            ));
    }
}
