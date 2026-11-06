//! A retained native Office phone, with a constructor-fixed session and the
//! installing worker's actual stop lifetime. Addresses/paths are installation
//! data; neither a phone handle nor Basic transport authentication is a grant.
use crate::{installed_worker_engine::InstalledWorkerEngine, worker_runtime::WorkerRuntime};
use reverie_core::ids::ProfileSessionId;
use std::{
    collections::BTreeMap,
    fmt, io,
    net::{IpAddr, SocketAddr},
    path::PathBuf,
    sync::{
        Arc, Mutex, MutexGuard, OnceLock, RwLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};
use tokio::sync::Semaphore;
mod body;
mod credentials;
mod io_timeout;
mod policy;
mod proxy;
mod server;
mod socket;
#[cfg(test)]
mod test_hooks;
#[cfg(test)]
mod tests;

#[derive(Debug)]
pub enum OfficeError {
    Io(io::Error),
    Refused,
    Closed,
    Unconfirmed,
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
            Self::Unconfirmed => "Office close unconfirmed; retain its owner",
            Self::Finalization { .. } => "Office operation and cleanup failed; retain its owner",
        })
    }
}
impl std::error::Error for OfficeError {}
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
    root: PathBuf,
    address: RwLock<SocketAddr>,
    engine: Arc<InstalledWorkerEngine>,
    closing: AtomicBool,
}
struct OwnedOffice {
    closing: Arc<AtomicBool>,
    first_close: OnceLock<Instant>,
    thread: Mutex<Option<JoinHandle<Result<()>>>>,
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
                root: company_root,
                address: RwLock::new(SocketAddr::new(address, 3000)),
                engine: Arc::clone(runtime.installed_engine()),
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
        *self
            .company
            .address
            .write()
            .map_err(|_| OfficeError::Unconfirmed)? = SocketAddr::new(address, 3000);
        Ok(())
    }
    pub fn bind(&self, directory: PathBuf, session: ProfileSessionId) -> Result<OfficePhone> {
        self.require_running()?;
        let runtime = server::runtime()?;
        let mut offices = self.offices.lock().map_err(|_| OfficeError::Unconfirmed)?;
        self.require_running()?;
        let closing = Arc::new(AtomicBool::new(false));
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (listener, socket) = match socket::bind(&directory) {
            Ok(bound) => bound,
            Err(error) => {
                if matches!(
                    error,
                    OfficeError::Finalization { .. } | OfficeError::Unconfirmed
                ) {
                    offices.insert(
                        id,
                        Arc::new(OwnedOffice {
                            closing,
                            first_close: OnceLock::new(),
                            thread: Mutex::new(None),
                            _preparation: None,
                        }),
                    );
                }
                return Err(error);
            }
        };
        let context = server::Context::new(
            Arc::clone(&self.company),
            session.clone(),
            Arc::clone(&closing),
        );
        let payload = Arc::new(Mutex::new(Some(server::PreparedOffice::new(
            runtime, listener, socket, context,
        ))));
        let owned = Arc::new(OwnedOffice {
            closing,
            first_close: OnceLock::new(),
            thread: Mutex::new(None),
            _preparation: Some(Arc::clone(&payload)),
        });
        offices.insert(id, Arc::clone(&owned));
        // Acquire the fresh slot before starting a thread; no failed lock can
        // cause an already-created JoinHandle to be dropped and detached.
        let mut slot = owned.thread.lock().map_err(|_| OfficeError::Unconfirmed)?;
        match server::spawn(&payload) {
            Ok(thread) => *slot = Some(thread),
            Err(error) => {
                let cleanup = server::cleanup_payload(&payload);
                if cleanup.is_ok() {
                    offices.remove(&id);
                }
                return finalized(Err(error.into()), cleanup);
            }
        }
        drop(slot);
        let phone = OfficePhone {
            id,
            owned,
            origin: Arc::clone(&self.company.engine),
            session,
        };
        if let Err(error) = self.require_running() {
            phone.request_close();
            return Err(error);
        }
        Ok(phone)
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
        let mut offices = lock_until(&self.offices, self.deadline(deadline))?;
        let mut failed = false;
        offices.retain(|_, office| {
            let retain = close(office, self.deadline(deadline)).is_err();
            failed |= retain;
            retain
        });
        if failed {
            Err(OfficeError::Unconfirmed)
        } else {
            Ok(())
        }
    }
    fn deadline(&self, deadline: Instant) -> Instant {
        self.company
            .engine
            .stop_deadline()
            .map_or(deadline, |stop| stop.min(deadline))
    }
}
impl OfficePhone {
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
    let Some(thread) = slot.as_ref() else {
        return Err(OfficeError::Unconfirmed);
    };
    while !thread.is_finished() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(OfficeError::Unconfirmed);
        }
        std::thread::sleep(remaining.min(Duration::from_millis(5)));
    }
    slot.take()
        .ok_or(OfficeError::Unconfirmed)?
        .join()
        .map_err(|_| OfficeError::Unconfirmed)?
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
        // An accidental coordinator drop must not detach an outstanding native
        // server thread or erase its failed close. These owners remain retained
        // for process lifetime; Drop is deliberately never a capacity ACK.
        static ABANDONED: OnceLock<Mutex<Vec<Arc<OwnedOffice>>>> = OnceLock::new();
        let abandoned = ABANDONED.get_or_init(|| Mutex::new(Vec::new()));
        let mut abandoned = abandoned.lock().unwrap_or_else(|error| error.into_inner());
        let offices = self
            .offices
            .get_mut()
            .unwrap_or_else(|error| error.into_inner());
        abandoned.extend(std::mem::take(offices).into_values());
    }
}
