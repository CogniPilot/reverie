//! A retained native Office phone, with a constructor-fixed session and the
//! installing worker's actual stop lifetime. Addresses/paths are installation
//! data; neither a phone handle nor Basic transport authentication is a grant.
use crate::{installed_worker_engine::InstalledWorkerEngine, worker_runtime::WorkerRuntime};
use reverie_contracts::{
    storage_identity::MetadataText,
    worker_config::EffectiveWorkerConfig,
    worker_schema::{WorkerEnvelope, WorkerPath},
};
use reverie_core::ids::ProfileSessionId;
use std::{
    collections::BTreeMap,
    fmt, io,
    net::{IpAddr, SocketAddr},
    path::PathBuf,
    sync::{
        Arc, Mutex, MutexGuard, OnceLock,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};
use tokio::sync::Semaphore;
mod address;
mod body;
mod construction;
mod retention;
pub use construction::{OfficeBindFailure, OfficeConstruction};
mod credentials;
mod images;
mod io_timeout;
pub use images::{OfficeImageBinding, OfficeImageError, OfficeImageReader};
mod native_jobs;
mod policy;
mod proxy;
mod request;
mod server;
mod socket;
mod telemetry;
#[cfg(test)]
mod test_hooks;
#[cfg(test)]
mod tests;
mod worker_path;

#[derive(Debug)]
pub enum OfficeError {
    Io(io::Error),
    Refused,
    Closed,
    Deadline,
    Unconfirmed,
    Server(Arc<Self>),
    Task(Arc<Self>),
    Backend(Arc<crate::worker_recovery::WorkerRecoveryError>),
    Finalization {
        primary: Box<Self>,
        secondary: Box<Self>,
    },
}
impl fmt::Display for OfficeError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(match self {
            Self::Io(_) => "Office transport unavailable",
            Self::Refused => "Office request refused",
            Self::Closed => "Office is closing",
            Self::Deadline => "Office bind deadline expired",
            Self::Unconfirmed => "Office close unconfirmed; retain its owner",
            Self::Server(_) => "Office server failed; retain its owner",
            Self::Task(_) => "Office native work failed",
            Self::Backend(_) => "Office backend unavailable",
            Self::Finalization { .. } => "Office operation and cleanup failed; retain its owner",
        })
    }
}
impl std::error::Error for OfficeError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Server(error) | Self::Task(error) => Some(error.as_ref()),
            Self::Backend(error) => Some(error.as_ref()),
            Self::Finalization { primary, .. } => Some(primary.as_ref()),
            Self::Refused | Self::Closed | Self::Deadline | Self::Unconfirmed => None,
        }
    }
}
impl From<io::Error> for OfficeError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}
type Result<T> = std::result::Result<T, OfficeError>;
fn finalized<T>(result: Result<T>, cleanup: Result<()>) -> Result<T> {
    match (result, cleanup) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(primary), Err(secondary)) => Err(OfficeError::Finalization {
            primary: Box::new(primary),
            secondary: Box::new(secondary),
        }),
    }
}
struct Company {
    root: MetadataText,
    worker_socket_root: Option<MetadataText>,
    address: address::AddressSource,
    native_jobs: native_jobs::NativeJobs,
    telemetry: Option<Arc<crate::command_telemetry::CommandTelemetry>>,
    engine: Arc<InstalledWorkerEngine>,
    closing: AtomicBool,
}
impl Company {
    fn root(&self) -> Result<PathBuf> {
        Ok(crate::native::python_path(self.root.codepoints())?)
    }
    fn telemetry_settled(&self) -> bool {
        self.telemetry
            .as_ref()
            .is_none_or(|owner| !owner.has_pending_store())
    }
}
struct OwnedOffice {
    closing: Arc<AtomicBool>,
    first_close: OnceLock<Instant>,
    thread: Mutex<Option<JoinHandle<Result<()>>>>,
    joined: Mutex<Option<std::result::Result<(), Arc<OfficeError>>>>,
    live_requests: Arc<AtomicUsize>,
    _preparation: Option<server::SpawnPayload>,
}
/// Own one registry for the installing broker. Dropping an individual phone
/// never drops its actual server/request ownership. Explicit close is required;
/// a deadline is an observation bound, never an acknowledgement of settlement.
#[must_use = "retain the registry through actual Office shutdown"]
pub struct OfficeService {
    company: Arc<Company>,
    offices: Mutex<BTreeMap<u64, Arc<OwnedOffice>>>,
    next: AtomicU64,
}
#[must_use = "close the actual phone before releasing its lifecycle resources"]
pub struct OfficePhone {
    id: u64,
    owned: Arc<OwnedOffice>,
    origin: Arc<InstalledWorkerEngine>,
    session: ProfileSessionId,
    endpoint: (PathBuf, Option<[u64; 2]>),
}
impl OfficeService {
    /// The same service-captured worker engine supplies stop/cancellation;
    /// constructing an Office never captures another engine or service key.
    pub fn from_runtime(
        runtime: &WorkerRuntime,
        company_root: PathBuf,
        address: IpAddr,
    ) -> Result<Self> {
        if !company_root.is_absolute() {
            return Err(OfficeError::Refused);
        }
        Ok(Self {
            company: Arc::new(Company {
                root: MetadataText::from_python_text(
                    reverie_core::PythonText::try_new(crate::native::python_text(&company_root))
                        .expect("filesystem text"),
                ),
                worker_socket_root: None,
                address: address::AddressSource::fixed(SocketAddr::new(address, 3000)),
                native_jobs: native_jobs::NativeJobs::new(),
                telemetry: None,
                engine: Arc::clone(runtime.installed_engine()),
                closing: AtomicBool::new(false),
            }),
            offices: Mutex::new(BTreeMap::new()),
            next: AtomicU64::new(0),
        })
    }
    /// Actual worker origin, captured configuration and lazy fixed server.
    /// Construct only at the original phone phase, after storage recovery.
    pub fn from_worker(
        runtime: &WorkerRuntime,
        config: &EffectiveWorkerConfig,
        telemetry: Arc<crate::command_telemetry::CommandTelemetry>,
    ) -> Result<Self> {
        telemetry
            .assert_runtime(runtime)
            .map_err(|_| OfficeError::Refused)?;
        let envelope = WorkerEnvelope::capture(config.clone()).map_err(|_| OfficeError::Refused)?;
        if reverie_core::worker_schema::WorkerServiceIdentity::capture(envelope.base())
            != *runtime.worker_identity()
        {
            return Err(OfficeError::Refused);
        }
        Ok(Self {
            company: Arc::new(Company {
                root: envelope.path(WorkerPath::CompanyRoot).clone(),
                worker_socket_root: Some(envelope.path(WorkerPath::ApiSocketRoot).clone()),
                address: address::AddressSource::worker(envelope.base().container().to_owned()),
                native_jobs: native_jobs::NativeJobs::new(),
                telemetry: telemetry.enabled().then_some(telemetry),
                engine: runtime.installed_engine().clone(),
                closing: AtomicBool::new(false),
            }),
            offices: Mutex::new(BTreeMap::new()),
            next: AtomicU64::new(0),
        })
    }
    /// Installing broker's newly observed console address. Requests cannot
    /// choose this address, its port, the host credentials, or another session.
    pub fn update_address(&self, address: IpAddr) -> Result<()> {
        self.require_running()?;
        self.company
            .address
            .update_fixed(SocketAddr::new(address, 3000))
    }
    pub fn bind(&self, directory: PathBuf, session: ProfileSessionId) -> Result<OfficePhone> {
        self.bind_retained(directory, session)
            .map_err(|failure| failure.into_parts().0)
    }
    fn bind_attempt(
        &self,
        directory: PathBuf,
        session: ProfileSessionId,
        inherited_end: Option<Instant>,
        construction: &mut Option<OfficeConstruction>,
    ) -> Result<OfficePhone> {
        self.require_running()?;
        self.require_bind_deadline(inherited_end)?;
        let runtime = server::runtime()?;
        let mut offices = match inherited_end {
            Some(end) => lock_until(&self.offices, self.deadline(end))?,
            None => self.offices.lock().map_err(|_| OfficeError::Unconfirmed)?,
        };
        self.require_running()?;
        self.require_bind_deadline(inherited_end)?;
        let closing = Arc::new(AtomicBool::new(false));
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (listener, socket) = match socket::bind(&directory) {
            Ok(bound) => bound,
            Err(error) => {
                if matches!(
                    error,
                    OfficeError::Finalization { .. } | OfficeError::Unconfirmed
                ) {
                    let owned = Arc::new(OwnedOffice {
                        closing,
                        first_close: OnceLock::new(),
                        thread: Mutex::new(None),
                        joined: Mutex::new(None),
                        live_requests: Arc::new(AtomicUsize::new(0)),
                        _preparation: None,
                    });
                    owned.closing.store(true, Ordering::Release);
                    offices.insert(id, owned.clone());
                    *construction = Some(OfficeConstruction::captured(self, id, &owned));
                }
                return Err(error);
            }
        };
        let endpoint = socket.observation();
        let live_requests = Arc::new(AtomicUsize::new(0));
        let context = server::Context::new(
            Arc::clone(&self.company),
            session.clone(),
            Arc::clone(&closing),
            live_requests.clone(),
        );
        let payload = Arc::new(Mutex::new(Some(server::PreparedOffice::new(
            runtime, listener, socket, context,
        ))));
        let owned = Arc::new(OwnedOffice {
            closing,
            first_close: OnceLock::new(),
            thread: Mutex::new(None),
            joined: Mutex::new(None),
            live_requests,
            _preparation: Some(Arc::clone(&payload)),
        });
        offices.insert(id, Arc::clone(&owned));
        *construction = Some(OfficeConstruction::captured(self, id, &owned));
        // Acquire the fresh slot before starting a thread; no failed lock can
        // cause an already-created JoinHandle to be dropped and detached.
        let mut slot = owned.thread.lock().map_err(|_| OfficeError::Unconfirmed)?;
        let spawned = self
            .require_bind_deadline(inherited_end)
            .and_then(|()| server::spawn(&payload).map_err(OfficeError::from));
        match spawned {
            Ok(thread) => *slot = Some(thread),
            Err(error) => {
                let cleanup = server::cleanup_payload(&payload);
                if cleanup.is_ok() {
                    offices.remove(&id);
                    *construction = None;
                }
                return finalized(Err(error), cleanup);
            }
        }
        drop(slot);
        #[cfg(test)]
        if test_hooks::stop_after_spawn() {
            self.request_close();
        }
        let phone = OfficePhone {
            id,
            owned,
            origin: Arc::clone(&self.company.engine),
            session,
            endpoint,
        };
        if let Err(error) = self
            .require_running()
            .and_then(|()| self.require_bind_deadline(inherited_end))
        {
            phone.request_close();
            return Err(error);
        }
        *construction = None;
        Ok(phone)
    }
    fn require_bind_deadline(&self, inherited_end: Option<Instant>) -> Result<()> {
        if inherited_end.is_some_and(|end| Instant::now() >= self.deadline(end)) {
            Err(OfficeError::Deadline)
        } else {
            Ok(())
        }
    }
    fn require_running(&self) -> Result<()> {
        if self.company.closing.load(Ordering::Acquire)
            || self.company.engine.cancellation().is_cancelled()
        {
            Err(OfficeError::Closed)
        } else {
            Ok(())
        }
    }
    pub fn close_phone(&self, phone: &OfficePhone, deadline: Instant) -> Result<()> {
        let mut offices = lock_until(&self.offices, self.deadline(deadline))?;
        let owned = offices.get(&phone.id).ok_or(OfficeError::Closed)?;
        if !Arc::ptr_eq(owned, &phone.owned) {
            return Err(OfficeError::Refused);
        }
        close(owned, self.deadline(deadline))?;
        offices.remove(&phone.id);
        Ok(())
    }
    pub fn request_close(&self) {
        self.company.closing.store(true, Ordering::Release);
    }
    /// Every actual owner gets a close attempt. Failures retain their registry
    /// entries; closing one phone cannot stand in for closing the entire broker.
    pub fn close(&self, deadline: Instant) -> Result<()> {
        self.request_close();
        // Abort servers first, then settle all native jobs even when a phone
        // has failed. Jobs own the same real request seats after cancellation.
        let jobs = finalized(
            self.company.native_jobs.close(self.deadline(deadline)),
            if self.company.telemetry_settled() {
                Ok(())
            } else {
                Err(OfficeError::Unconfirmed)
            },
        );
        let mut offices = match lock_until(&self.offices, self.deadline(deadline)) {
            Ok(offices) => offices,
            Err(error) => return finalized(jobs, Err(error)),
        };
        let mut result = jobs;
        offices.retain(|_, office| match close(office, self.deadline(deadline)) {
            Ok(()) => false,
            Err(error) => {
                result = finalized(std::mem::replace(&mut result, Ok(())), Err(error));
                true
            }
        });
        result
    }
    fn deadline(&self, deadline: Instant) -> Instant {
        self.company
            .engine
            .stop_deadline()
            .map_or(deadline, |stop| stop.min(deadline))
    }
}
impl OfficePhone {
    /// Read only the actual close/join result of this retained phone. An idle
    /// still-listening producer, closing request, or consumed failure is not a
    /// future-request fence for physical storage return.
    pub fn require_closed_for_resource(
        &self,
        runtime: &WorkerRuntime,
        session: &ProfileSessionId,
    ) -> Result<()> {
        if !Arc::ptr_eq(&self.origin, runtime.installed_engine()) || &self.session != session {
            return Err(OfficeError::Refused);
        }
        let thread = self
            .owned
            .thread
            .try_lock()
            .map_err(|_| OfficeError::Unconfirmed)?;
        let joined = self
            .owned
            .joined
            .try_lock()
            .map_err(|_| OfficeError::Unconfirmed)?;
        if !self.owned.closing.load(Ordering::Acquire)
            || thread.is_some()
            || self.owned.live_requests.load(Ordering::Acquire) != 0
        {
            return Err(OfficeError::Unconfirmed);
        }
        match joined.as_ref() {
            Some(Ok(())) => Ok(()),
            Some(Err(error)) => Err(OfficeError::Server(error.clone())),
            None => Err(OfficeError::Unconfirmed),
        }
    }
    pub(crate) fn assert_runtime_session(
        &self,
        runtime: &WorkerRuntime,
        session: &ProfileSessionId,
    ) -> Result<()> {
        if !Arc::ptr_eq(&self.origin, runtime.installed_engine()) || &self.session != session {
            return Err(OfficeError::Refused);
        }
        if self.owned.closing.load(Ordering::Acquire) {
            return Err(OfficeError::Closed);
        }
        Ok(())
    }
    pub fn request_close(&self) {
        self.owned.closing.store(true, Ordering::Release);
    }
}
fn close(owned: &OwnedOffice, deadline: Instant) -> Result<()> {
    owned.closing.store(true, Ordering::Release);
    let deadline =
        deadline.min(*owned.first_close.get_or_init(Instant::now) + Duration::from_secs(2));
    let mut slot = lock_until(&owned.thread, deadline)?;
    while slot.as_ref().is_some_and(|thread| !thread.is_finished()) {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(OfficeError::Unconfirmed);
        }
        std::thread::sleep(remaining.min(Duration::from_millis(5)));
    }
    let mut joined = lock_until(&owned.joined, deadline)?;
    if let Some(thread) = slot.take() {
        let result = thread
            .join()
            .unwrap_or(Err(OfficeError::Unconfirmed))
            .map_err(Arc::new);
        *joined = Some(result);
    }
    let result = joined.as_ref().ok_or(OfficeError::Unconfirmed)?;
    if let Err(error) = result {
        return Err(OfficeError::Server(error.clone()));
    }
    if owned.live_requests.load(Ordering::Acquire) != 0 {
        return Err(OfficeError::Unconfirmed);
    }
    Ok(())
}
fn global_slots() -> Arc<Semaphore> {
    static SLOTS: OnceLock<Arc<Semaphore>> = OnceLock::new();
    Arc::clone(SLOTS.get_or_init(|| Arc::new(Semaphore::new(32))))
}
fn lock_until<T>(lock: &Mutex<T>, deadline: Instant) -> Result<MutexGuard<'_, T>> {
    loop {
        match lock.try_lock() {
            Ok(held) => return Ok(held),
            Err(std::sync::TryLockError::Poisoned(_)) => return Err(OfficeError::Unconfirmed),
            Err(std::sync::TryLockError::WouldBlock) => (),
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(OfficeError::Unconfirmed);
        }
        std::thread::sleep(remaining.min(Duration::from_millis(5)));
    }
}
impl Drop for OfficeService {
    fn drop(&mut self) {
        self.request_close();
        if self
            .offices
            .get_mut()
            .is_ok_and(|offices| offices.is_empty())
            && self.company.native_jobs.known_settled()
            && self.company.telemetry_settled()
        {
            return;
        }
        // An accidental coordinator drop must not detach an outstanding native
        // server thread or erase its failed close. These owners remain retained
        // for process lifetime; Drop is deliberately never a capacity ACK.
        type AbandonedCompany = (Arc<Company>, Vec<Arc<OwnedOffice>>);
        static ABANDONED: OnceLock<Mutex<Vec<AbandonedCompany>>> = OnceLock::new();
        let abandoned = ABANDONED.get_or_init(|| Mutex::new(Vec::new()));
        let mut abandoned = abandoned.lock().unwrap_or_else(|error| error.into_inner());
        let offices = self
            .offices
            .get_mut()
            .unwrap_or_else(|error| error.into_inner());
        abandoned.push((
            self.company.clone(),
            std::mem::take(offices).into_values().collect(),
        ));
    }
}
