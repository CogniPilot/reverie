//! The actual J connection shares T's bounded native registry. This value is
//! peer/request/resource provenance, never allocation or permission to start.
use super::*;
use reverie_contracts::{worker_config::EffectiveWorkerConfig, worker_launch::WorkerRequest};

#[must_use = "retain the actual accepted connection until checked close"]
pub struct WorkerLaunchConnection {
    service: Arc<WorkerReportService>,
    record: Arc<Record>,
    request: WorkerRequest,
}
/// A completed report or an actual still-owned J socket. No decoded request
/// can manufacture either branch or transfer ownership from a different run.
pub enum AcceptedWorkerConnection {
    ReportCompleted,
    Launch(WorkerLaunchConnection),
}
impl WorkerReportService {
    /// A current-configuration failure still consumes the actual accepted
    /// socket through this same registry and checked finalizer owner.
    pub fn close_unread_launch(&self, stream: UnixStream) -> Result<()> {
        let record = self.admit(stream)?;
        self.finish_accepted(&record)
    }
    /// Register before reading; check the kernel UID before any frame/request.
    /// Configuration is ordinary captured data, not a substitute for App's
    /// actual optional admission, current intent or held lifecycle.
    pub fn accept(
        self: &Arc<Self>,
        stream: UnixStream,
        collector: &CommandTelemetry,
        configuration: &EffectiveWorkerConfig,
    ) -> Result<AcceptedWorkerConnection> {
        let record = self.admit(stream)?;
        match record.read_request(self, collector, configuration) {
            Ok(Some(request)) => Ok(AcceptedWorkerConnection::Launch(WorkerLaunchConnection {
                service: self.clone(),
                record,
                request,
            })),
            Ok(None) => {
                self.finish_accepted(&record)?;
                Ok(AcceptedWorkerConnection::ReportCompleted)
            }
            Err(error) => finalized(Err(error), self.finish_accepted(&record)),
        }
    }
    fn finish_accepted(&self, record: &Arc<Record>) -> Result<()> {
        let end = self
            .engine
            .stop_deadline()
            .unwrap_or_else(|| Instant::now() + Duration::from_secs(10));
        let result = record.finish_launch(end);
        finalized(result, self.retire_launch(record, end))
    }
    fn retire_launch(&self, record: &Arc<Record>, end: Instant) -> Result<()> {
        if !record.settled() {
            return Err(WorkerReportError::Unconfirmed);
        }
        let mut records = self.lock_until(end)?;
        records.retain(|other| !Arc::ptr_eq(other, record));
        Ok(())
    }
}
impl WorkerLaunchConnection {
    pub fn assert_open(&self, runtime: &WorkerRuntime) -> Result<()> {
        if !self.same_runtime(runtime) || !self.record.can_progress() || self.service.stopping() {
            return Err(WorkerReportError::Unconfirmed);
        }
        Ok(())
    }
    pub fn request(&self) -> &WorkerRequest {
        &self.request
    }
    pub fn same_runtime(&self, runtime: &WorkerRuntime) -> bool {
        Arc::ptr_eq(&self.service.engine, runtime.installed_engine())
    }
    pub fn same_connection(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.service, &other.service) && Arc::ptr_eq(&self.record, &other.record)
    }
    /// Interrupt only this actual accepted socket, without changing another
    /// connection, the shared native engine, or the broker's stop budget.
    pub fn interrupt(&self) -> Result<()> {
        self.record.interrupt()
    }
    pub fn close(&self, requested: Instant) -> Result<()> {
        let end = self
            .service
            .engine
            .stop_deadline()
            .map_or(requested, |stop| stop.min(requested));
        let result = self.record.finish_launch(end);
        finalized(result, self.service.retire_launch(&self.record, end))
    }
}
impl Drop for WorkerLaunchConnection {
    fn drop(&mut self) {
        // A contended or opaque last Drop remains in the SAME service registry
        // and ultimately its process-lifetime quarantine. No positive ACK.
        let _ = self.close(Instant::now());
    }
}
