//! A read-only exclusion snapshot for one actual C. It cannot interrupt,
//! reconcile, join, stop or release any other original handler.
use super::*;
use reverie_contracts::worker_control::WorkerControlRequest;

pub struct WorkerRecoveryExclusion {
    service: Arc<WorkerReportService>,
    own: Arc<Record>,
}
impl WorkerServiceConnection {
    pub fn retain_empty_recovery_handlers(
        &self,
        expected: &Arc<WorkerReportService>,
        runtime: &WorkerRuntime,
    ) -> Result<WorkerRecoveryExclusion> {
        let owner = WorkerRecoveryExclusion {
            service: Arc::clone(expected),
            own: Arc::clone(&self.record),
        };
        owner.assert_current(self, expected, runtime)?;
        Ok(owner)
    }
}
impl WorkerRecoveryExclusion {
    pub fn assert_current(
        &self,
        connection: &WorkerServiceConnection,
        expected: &Arc<WorkerReportService>,
        runtime: &WorkerRuntime,
    ) -> Result<()> {
        connection.assert_service(expected)?;
        if !Arc::ptr_eq(&self.service, expected)
            || !Arc::ptr_eq(&self.own, &connection.record)
            || !connection.same_runtime(runtime)
            || expected.stopping()
            || connection.purpose() != WorkerServicePurpose::Control
            || !matches!(
                WorkerControlRequest::decode(connection.request_bytes()),
                Ok(WorkerControlRequest::PoolRecoveryStatus)
            )
            || connection.record.opaque()
            || !connection.record.can_progress()
        {
            return Err(WorkerReportError::Unconfirmed);
        }
        connection.record.require_terminal_hold()?;
        let records = expected
            .records
            .try_lock()
            .map_err(|_| WorkerReportError::Unconfirmed)?;
        if records.len() != 1 || !Arc::ptr_eq(&records[0], &self.own) {
            return Err(WorkerReportError::Unconfirmed);
        }
        Ok(())
    }
}
