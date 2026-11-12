use super::*;
/// Exact actual accepted record, not a PID, request selector or authorization.
#[derive(Clone)]
pub(crate) struct RelayIdentity {
    service: std::sync::Weak<WorkerReportService>,
    record: Arc<Record>,
}
impl RelayIdentity {
    pub(in crate::worker_reports) fn new(
        service: &Arc<WorkerReportService>,
        record: Arc<Record>,
    ) -> Self {
        Self {
            service: Arc::downgrade(service),
            record,
        }
    }
    pub(crate) fn same(&self, other: &Self) -> bool {
        std::sync::Weak::ptr_eq(&self.service, &other.service)
            && Arc::ptr_eq(&self.record, &other.record)
    }
    pub(crate) fn require_released_predecessor(
        &self,
        next: &Self,
    ) -> std::result::Result<(), &'static str> {
        if self.same(next) || !std::sync::Weak::ptr_eq(&self.service, &next.service) {
            return Err("WORKER_STARTED_CONNECTION_SERVICE_CHANGED");
        }
        self.require_released()
    }
    pub(crate) fn require_released(&self) -> std::result::Result<(), &'static str> {
        self.record
            .require_released_handler()
            .map_err(|_| "WORKER_STARTED_PREDECESSOR_RETAINED")
    }
    pub(crate) fn can_progress(&self) -> bool {
        self.service
            .upgrade()
            .is_some_and(|service| !service.stopping())
            && self.record.can_progress()
            && self.record.require_terminal_hold().is_ok()
    }
    /// Read the original service/record without treating opacity or ordinary
    /// hold contention as a positive known-cancellation result. No I/O or join.
    pub(crate) fn observe_progress(&self) -> std::result::Result<Option<bool>, WorkerReportError> {
        let service = self
            .service
            .upgrade()
            .ok_or(WorkerReportError::Unconfirmed)?;
        if service.opaque.load(std::sync::atomic::Ordering::Acquire) || self.record.opaque() {
            return Err(WorkerReportError::Unconfirmed);
        }
        let progress = self
            .record
            .terminal_progress()?
            .map(|live| live && !service.stopping());
        if service.opaque.load(std::sync::atomic::Ordering::Acquire) || self.record.opaque() {
            return Err(WorkerReportError::Unconfirmed);
        }
        Ok(progress)
    }
}
