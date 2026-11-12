//! Closed C maintenance facade over the SAME counted selection/progress. It
//! cannot be constructed from Q, a PID/SID list, or copied closure metadata.
use super::*;
use reverie_contracts::worker_control::WorkerControlRequest;
#[must_use = "retain actual original handler owners through checked settlement"]
pub struct WorkerServiceMaintenanceHandlers {
    inner: Option<WorkerOriginalHandlersDrain>,
}
pub(super) fn assert_connection(
    connection: &WorkerServiceConnection,
    expected: &Arc<WorkerReportService>,
    runtime: &WorkerRuntime,
) -> Result<()> {
    connection.assert_service(expected)?;
    if connection.purpose() != WorkerServicePurpose::Control
        || !connection.same_runtime(runtime)
        || expected.stopping()
        || !matches!(
            WorkerControlRequest::decode(connection.request_bytes()),
            Ok(WorkerControlRequest::QuiesceForDeployment)
        )
        || connection.record.opaque()
        || !connection.record.can_progress()
    {
        return Err(WorkerReportError::Unconfirmed);
    }
    connection.record.require_terminal_hold()
}
impl WorkerServiceConnection {
    pub fn retain_deployment_handlers(
        &self,
        expected: &Arc<WorkerReportService>,
        runtime: &WorkerRuntime,
        end: Instant,
    ) -> Result<WorkerServiceMaintenanceHandlers> {
        assert_connection(self, expected, runtime)?;
        Ok(WorkerServiceMaintenanceHandlers {
            inner: Some(WorkerOriginalHandlersDrain::capture(
                self,
                expected,
                end,
                SelectionPurpose::Deployment,
            )?),
        })
    }
}
impl WorkerServiceMaintenanceHandlers {
    pub fn advance_interruption(
        &mut self,
        connection: &WorkerServiceConnection,
        expected: &Arc<WorkerReportService>,
        runtime: &WorkerRuntime,
    ) -> DrainResult<WorkerOriginalInterruptionProgress> {
        let inner = self.inner.as_mut().expect("same original selection");
        inner.interrupt_owned(ForwardOwner::Deployment(connection), expected, runtime)?;
        Ok(if inner.admitted && inner.interrupted {
            WorkerOriginalInterruptionProgress::Issued
        } else {
            WorkerOriginalInterruptionProgress::Pending
        })
    }
    pub fn settle(&mut self, runtime: &WorkerRuntime) -> DrainResult<WorkerHandlersProgress> {
        self.inner
            .as_mut()
            .expect("same original selection")
            .settle(runtime)
    }
    pub fn deadline(&self, runtime: &WorkerRuntime) -> Result<Instant> {
        self.inner
            .as_ref()
            .expect("same original selection")
            .deadline(runtime)
    }
    pub fn into_closed(mut self) -> std::result::Result<WorkerOriginalHandlersClosed, Box<Self>> {
        match self
            .inner
            .take()
            .expect("same original selection")
            .into_closed()
        {
            Ok(closed) => Ok(closed),
            Err(inner) => {
                self.inner = Some(*inner);
                Err(Box::new(self))
            }
        }
    }
}
impl WorkerOriginalHandlersClosed {
    /// Original C provenance after selected jobs/socket/Holds actually closed.
    /// This remains neither native-resource closure nor a current stop grant.
    pub fn assert_deployment_owner(
        &self,
        connection: &WorkerServiceConnection,
        expected: &Arc<WorkerReportService>,
        runtime: &WorkerRuntime,
    ) -> Result<()> {
        if self.selection.purpose != SelectionPurpose::Deployment
            || !self.selection.same_runtime(runtime)
            || !connection.same_runtime(runtime)
            || !Arc::ptr_eq(expected, &self.selection.service)
            || !Arc::ptr_eq(&connection.service, expected)
            || !Arc::ptr_eq(&connection.record, &self.selection.own)
            || connection.purpose() != WorkerServicePurpose::Control
            || !matches!(
                WorkerControlRequest::decode(connection.request_bytes()),
                Ok(WorkerControlRequest::QuiesceForDeployment)
            )
        {
            return Err(WorkerReportError::Unconfirmed);
        }
        Ok(())
    }
}
