//! Independent, attach-only terminal service. It has no laptop/storage lease,
//! reservation admission, controller, launch command or provider restart path.
mod attach;
mod socket;
#[cfg(test)]
mod tests;
mod wire;
use crate::{
    broker_listener, engine_metadata::EngineBootstrap,
    installed_worker_engine::InstalledWorkerEngine,
};
use reverie_contracts::{worker_config::EffectiveWorkerConfig, worker_launch::WorkerRequest};
use std::{
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

#[derive(Debug)]
pub struct ViewerError {
    code: &'static str,
    cause: Option<Box<dyn std::error::Error + Send + Sync>>,
    secondary: Option<Box<Self>>,
    retained: bool,
}
impl ViewerError {
    fn refused(code: &'static str) -> Self {
        Self {
            code,
            cause: None,
            secondary: None,
            retained: false,
        }
    }
    fn caused(code: &'static str, cause: impl std::error::Error + Send + Sync + 'static) -> Self {
        Self {
            code,
            cause: Some(Box::new(cause)),
            secondary: None,
            retained: false,
        }
    }
}
impl std::fmt::Display for ViewerError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str(self.code)?;
        if let Some(secondary) = &self.secondary {
            write!(out, "; secondary={secondary}")?;
        }
        Ok(())
    }
}
impl std::error::Error for ViewerError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.cause.as_deref().map(|cause| cause as _)
    }
}
impl From<std::io::Error> for ViewerError {
    fn from(cause: std::io::Error) -> Self {
        Self::caused("WORKER_VIEWER_IO", cause)
    }
}
type Result<T> = std::result::Result<T, ViewerError>;
const MAX_VIEWERS: usize = 32;
const HANDSHAKE_SECONDS: u64 = 10;

pub struct WorkerViewerService {
    source: PathBuf,
    engine: Arc<InstalledWorkerEngine>,
    active: AtomicUsize,
    closing: AtomicBool,
    retained: std::sync::Mutex<Vec<attach::Attach>>,
}
struct Slot(Arc<WorkerViewerService>);
impl Drop for Slot {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::AcqRel);
    }
}
impl WorkerViewerService {
    pub fn new(source: &Path, bootstrap: EngineBootstrap) -> Result<Arc<Self>> {
        let (_, source) = crate::worker_validation::load_owner_configuration_with_source(source)
            .map_err(|cause| ViewerError::caused("WORKER_VIEWER_CONFIGURATION", cause))?;
        Ok(Arc::new(Self {
            source,
            engine: Arc::new(InstalledWorkerEngine::new(bootstrap)),
            active: AtomicUsize::new(0),
            closing: AtomicBool::new(false),
            retained: std::sync::Mutex::new(Vec::new()),
        }))
    }
    fn configuration(&self) -> Result<EffectiveWorkerConfig> {
        crate::worker_validation::load_owner_configuration(&self.source)
            .map_err(|cause| ViewerError::caused("WORKER_VIEWER_CONFIGURATION", cause))
    }
    /// The socket is a separate owner-selected endpoint. Stopping this process
    /// affects its own terminal clients only; it never stops an employee.
    pub fn run(self: Arc<Self>, socket: &Path) -> Result<()> {
        let signals = crate::native::child_signals::SignalGuard::install()
            .map_err(|cause| ViewerError::caused("WORKER_VIEWER_SIGNALS", cause.cause))?;
        let body = match self
            .configuration()
            .and_then(|configuration| socket::Ownership::acquire(&configuration, socket))
        {
            Ok(ownership) => {
                socket::finalized(self.serve_socket(socket, &ownership), ownership.finish())
            }
            Err(cause) => Err(cause),
        };
        socket::finalized(body, signals.finish().map_err(Into::into))
    }

    fn serve_socket(self: &Arc<Self>, socket: &Path, ownership: &socket::Ownership) -> Result<()> {
        ownership.clear_stale()?;
        let mut bound = broker_listener::BoundSocket::bind(socket).map_err(listener_error)?;
        let body = bound
            .listener()
            .map_err(listener_error)
            .and_then(|listener| listener.set_nonblocking(true).map_err(Into::into))
            .and_then(|()| self.accept_connections(&bound));
        let removed = bound.remove().map(|_| ()).map_err(listener_error);
        let closed = self.finish_connections();
        socket::finalized(body, socket::finalized(removed, closed))
    }

    fn accept_connections(self: &Arc<Self>, bound: &broker_listener::BoundSocket) -> Result<()> {
        while crate::native::child_signals::signal().is_none() {
            let stream = match bound.listener().map_err(listener_error)?.accept() {
                Ok((stream, _)) => stream,
                Err(cause) if cause.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(10));
                    continue;
                }
                Err(cause) if cause.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(cause)
                    if matches!(
                        cause.raw_os_error(),
                        Some(
                            libc::EMFILE
                                | libc::ENFILE
                                | libc::ENOBUFS
                                | libc::ENOMEM
                                | libc::ECONNABORTED
                                | libc::EPROTO
                        )
                    ) =>
                {
                    eprintln!("{}", ViewerError::caused("WORKER_VIEWER_ACCEPT", cause));
                    std::thread::sleep(Duration::from_millis(100));
                    continue;
                }
                Err(cause) => {
                    return Err(ViewerError::caused("WORKER_VIEWER_LISTENER_FAILED", cause));
                }
            };
            if let Err(cause) = self.accept_connection(stream) {
                eprintln!("{cause}");
            }
        }
        Ok(())
    }

    fn accept_connection(
        self: &Arc<Self>,
        mut stream: std::os::unix::net::UnixStream,
    ) -> Result<()> {
        stream.set_write_timeout(Some(Duration::from_secs(2)))?;
        if broker_listener::peer_uid(&stream)? != crate::native::uid() {
            return Ok(());
        }
        if self
            .active
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                (count < MAX_VIEWERS).then_some(count + 1)
            })
            .is_err()
        {
            let _ = wire::send(&mut stream, b'E', b"WORKER_VIEWER_CAPACITY");
            return Ok(());
        }
        let slot = Slot(self.clone());
        std::thread::Builder::new()
            .name("reverie-terminal".into())
            .spawn(move || serve_connection(slot, stream))?;
        Ok(())
    }

    fn finish_connections(&self) -> Result<()> {
        self.closing.store(true, Ordering::Release);
        let end = Instant::now() + Duration::from_secs(15);
        while self.active.load(Ordering::Acquire) != 0 {
            if Instant::now() >= end {
                return Err(ViewerError::refused("WORKER_VIEWER_SERVICE_RETAINED"));
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        self.engine
            .close(end)
            .map_err(|cause| ViewerError::caused("WORKER_VIEWER_SERVICE_CLOSE", cause))?;
        Ok(())
    }
    fn handle(&self, stream: &mut std::os::unix::net::UnixStream) -> Result<()> {
        let end = Instant::now() + Duration::from_secs(HANDSHAKE_SECONDS);
        let (kind, raw) = wire::initial(stream, end)?;
        let configuration = self.configuration()?;
        let request = request(kind, &raw, &configuration)?;
        let target = attach::Target::observe(self, &configuration, request.session(), end)?;
        let mut viewer = attach::Attach::new();
        let result = viewer
            .start(&self.engine, &target, request.terminal())
            .and_then(|()| viewer.relay(self, stream, &request, &target));
        let closed = viewer.close(Instant::now() + Duration::from_secs(3));
        match (result, closed) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(cause), Ok(())) => Err(cause),
            (primary, Err(mut cause)) => {
                cause.retained = true;
                if let Err(primary) = primary {
                    cause.secondary = Some(Box::new(primary));
                }
                self.retained
                    .lock()
                    .unwrap_or_else(|cause| cause.into_inner())
                    .push(viewer);
                Err(cause)
            }
        }
    }
}
fn request(kind: u8, raw: &[u8], configuration: &EffectiveWorkerConfig) -> Result<WorkerRequest> {
    if kind != b'J' {
        return Err(ViewerError::refused("WORKER_VIEWER_ATTACH_ONLY"));
    }
    let request = WorkerRequest::decode(raw, configuration)
        .map_err(|cause| ViewerError::caused("WORKER_VIEWER_REQUEST", cause))?;
    if request.attach_only() != Some(true) {
        return Err(ViewerError::refused("WORKER_VIEWER_ATTACH_ONLY"));
    }
    Ok(request)
}
fn listener_error(cause: broker_listener::ListenerError) -> ViewerError {
    ViewerError::refused(cause.message())
}
fn serve_connection(slot: Slot, mut stream: std::os::unix::net::UnixStream) {
    if let Err(cause) = slot.0.handle(&mut stream) {
        let _ = wire::send(&mut stream, b'E', cause.code.as_bytes());
        eprintln!("{cause}");
        if cause.retained {
            std::mem::forget(slot);
        }
    }
}
