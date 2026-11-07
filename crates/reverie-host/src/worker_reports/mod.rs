//! Fixed T/J dispatch on an owned accepted UnixStream. Both purposes share
//! actual admission, runtime origin, socket custody and checked finalizers.
//! No listener, owner grant or successful create/start endpoint is created.
mod budget;
mod error;
mod handler;
mod launch;
mod listener;
pub use listener::{
    BrokerListenerError, BrokerListenerFailure, PreparedBrokerListener, WorkerBrokerListener,
};
mod protected_launch;
mod record;
mod registered;
pub use protected_launch::{
    HeldProtectedWorkerLaunch, ProtectedLaunchDecodeFailure, ProtectedLaunchHoldFailure,
    WorkerProtectedLaunchConnection,
};
mod resume;
mod service_connection;
pub use resume::{WorkerActorChannel, WorkerActorChannelFailure};
pub use service_connection::{
    AcceptedWorkerServiceConnection, WorkerPeer, WorkerServiceConnection, WorkerServicePurpose,
};
mod retention;
pub(crate) mod terminal;
pub use terminal::{ViewerRelay, ViewerRelayEnd, ViewerRelayError, ViewerRelayEvent};
#[cfg(test)]
mod tests;
mod wire;
use crate::{
    command_telemetry::{CommandTelemetry, TelemetryError},
    installed_worker_engine::InstalledWorkerEngine,
    worker_runtime::WorkerRuntime,
};
pub use error::WorkerReportError;
use error::{Result, finalized};
pub use handler::WorkerHandlerConstruction;
pub use launch::{AcceptedWorkerConnection, WorkerLaunchConnection};
use record::Record;
pub use registered::{RegisteredWorkerConnection, WorkerHandlersProgress};
pub use retention::{WorkerLaunchClose, WorkerLaunchHold};
use std::{
    os::unix::net::UnixStream,
    sync::{
        Arc, Mutex, OnceLock, TryLockError,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

#[must_use = "retain the report handler owner through checked connection shutdown"]
pub struct WorkerReportService {
    engine: Arc<InstalledWorkerEngine>,
    uid: u32,
    limit: usize,
    closed: AtomicBool,
    opaque: AtomicBool,
    records: Mutex<Vec<Arc<Record>>>,
}
impl WorkerReportService {
    /// Inert captured state: checked immutable UID/maxWorkers+4 and the SAME
    /// installed engine. No path, filesystem, socket or engine query.
    pub fn from_runtime(runtime: &WorkerRuntime) -> Self {
        Self {
            engine: runtime.installed_engine().clone(),
            uid: runtime.worker_identity().ids().uid(),
            limit: runtime.connection_limit(),
            closed: AtomicBool::new(false),
            opaque: AtomicBool::new(false),
            records: Mutex::new(Vec::new()),
        }
    }
    pub fn handle(&self, stream: UnixStream, collector: &CommandTelemetry) -> Result<()> {
        let record = self.admit(stream)?;
        let result = record.run(self, collector);
        if record.settled() {
            let mut records = match self.records.lock() {
                Ok(records) => records,
                Err(_) => {
                    self.opaque.store(true, Ordering::Release);
                    return finalized(result, Err(WorkerReportError::Unconfirmed));
                }
            };
            records.retain(|other| !Arc::ptr_eq(other, &record));
        }
        result
    }
    fn admit(&self, stream: UnixStream) -> Result<Arc<Record>> {
        let mut records = match self.records.lock() {
            Ok(records) => records,
            Err(_) => {
                self.opaque.store(true, Ordering::Release);
                return self.refuse(stream, WorkerReportError::Unconfirmed);
            }
        };
        if self.opaque.load(Ordering::Acquire) {
            return self.refuse(stream, WorkerReportError::Unconfirmed);
        }
        // A checked lifecycle release may have left only known-complete
        // bookkeeping while contending with this same admission mutex.
        records.retain(|record| !record.settled());
        if self.closed.load(Ordering::Acquire) || records.len() >= self.limit {
            return self.refuse(stream, WorkerReportError::Stopping);
        }
        let record = Arc::new(Record::new(stream));
        records.push(record.clone());
        Ok(record)
    }
    fn refuse(&self, stream: UnixStream, cause: WorkerReportError) -> Result<Arc<Record>> {
        let closed = record::close(stream);
        // Publish consumed-close uncertainty before dropping the SAME admission
        // mutex. No later close/admission may mistake a returning error's local
        // lifetime for confirmed native settlement.
        if closed.is_err() {
            self.opaque.store(true, Ordering::Release);
        }
        finalized(Err(cause), closed)
    }
    fn stopping(&self) -> bool {
        self.engine.cancellation().is_cancelled()
            || self.closed.load(Ordering::Acquire)
            || self.opaque.load(Ordering::Acquire)
    }
    /// Seal THIS admission, interrupt every owned socket, then wait for actual
    /// operation records and checked finalizers. This service owns no caller
    /// thread JoinHandle/listener except actual published same-record handlers.
    /// No other service/client is sealed here.
    pub fn close(&self, deadline: Instant) -> Result<()> {
        self.closed.store(true, Ordering::Release);
        let end = self
            .engine
            .stop_deadline()
            .map_or(deadline, |stop| stop.min(deadline));
        let records = self.lock_until(end)?.clone();
        let mut result = Ok(());
        for record in &records {
            result = finalized(result, record.interrupt());
        }
        for record in &records {
            result = finalized(result, record.settle_handler(end));
        }
        loop {
            if records.iter().all(|record| record.finished()) {
                break;
            }
            if Instant::now() >= end {
                return finalized(result, Err(WorkerReportError::Unconfirmed));
            }
            for record in &records {
                let _ = record.interrupt();
            }
            std::thread::sleep(
                end.saturating_duration_since(Instant::now())
                    .min(Duration::from_millis(5)),
            );
        }
        let mut retained = self.lock_until(end)?;
        retained.retain(|record| !record.settled());
        if !retained.is_empty() || self.opaque.load(Ordering::Acquire) {
            return finalized(result, Err(WorkerReportError::Unconfirmed));
        }
        result
    }
    fn lock_until(&self, end: Instant) -> Result<std::sync::MutexGuard<'_, Vec<Arc<Record>>>> {
        self.lock_budget(&budget::CleanupBudget::bounded(self, end))
    }
    fn lock_budget(
        &self,
        budget: &budget::CleanupBudget<'_>,
    ) -> Result<std::sync::MutexGuard<'_, Vec<Arc<Record>>>> {
        loop {
            match self.records.try_lock() {
                Ok(guard) => return Ok(guard),
                Err(TryLockError::Poisoned(error)) => {
                    self.opaque.store(true, Ordering::Release);
                    return Ok(error.into_inner());
                }
                Err(TryLockError::WouldBlock) => {}
            }
            budget.pause()?;
        }
    }
}
impl Drop for WorkerReportService {
    fn drop(&mut self) {
        self.closed.store(true, Ordering::Release);
        // Accidental Drop is no cleanup ACK. Preserve unconfirmed records and
        // their actual engine origin for process lifetime, including consumed
        // descriptors whose checked close returned an opaque failure.
        type Abandoned = (Arc<InstalledWorkerEngine>, Vec<Arc<Record>>);
        static ABANDONED: OnceLock<Mutex<Vec<Abandoned>>> = OnceLock::new();
        let records = match self.records.get_mut() {
            Ok(records) => records,
            Err(error) => {
                self.opaque.store(true, Ordering::Release);
                error.into_inner()
            }
        };
        let pending = records
            .drain(..)
            .filter(|record| !record.settled())
            .collect::<Vec<_>>();
        for record in &pending {
            let _ = record.interrupt();
        }
        // Even an empty registry may own consumed-but-unconfirmed refusal
        // close evidence. Keep that SAME origin, once per actual service.
        if !pending.is_empty() || self.opaque.load(Ordering::Acquire) {
            ABANDONED
                .get_or_init(|| Mutex::new(Vec::new()))
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .push((self.engine.clone(), pending));
        }
    }
}
