//! The original selection only: no admission, native action or closure grant.
use super::*;
use crate::worker_reports::terminal::RelayIdentity;

/// Opaque, immutable provenance retained with the actual App transition.
/// Its records are the SAME selection used by original interruption/settlement;
/// local progress and original typed diagnostics remain with the drain owner.
pub struct WorkerOriginalHandlersCleanupBinding {
    selection: Arc<Selection>,
}
impl WorkerOriginalHandlersDrain {
    pub fn cleanup_binding(&self) -> WorkerOriginalHandlersCleanupBinding {
        WorkerOriginalHandlersCleanupBinding {
            selection: Arc::clone(&self.originals().selection),
        }
    }
}
impl WorkerOriginalHandlersCleanupBinding {
    /// Match the actual originating fleet Q, service and runtime. Identity
    /// survives EOF/cancellation; it does not establish current authority.
    pub fn assert_owner(
        &self,
        channel: &WorkerActorChannel,
        expected: &Arc<WorkerReportService>,
        runtime: &WorkerRuntime,
    ) -> Result<()> {
        self.selection.assert_runtime(runtime)?;
        if !Arc::ptr_eq(expected, &self.selection.service)
            || !Arc::ptr_eq(&channel.connection.record, &self.selection.own)
            || channel.purpose != Purpose::FleetMaintenanceWebsite
        {
            return Err(WorkerReportError::Unconfirmed);
        }
        channel.assert_service(expected)
    }
    /// Match only this original typed J against the retained selection. The
    /// Gate must separately check its current transition, pending and target;
    /// this observation neither admits cleanup nor acknowledges settlement.
    pub fn assert_original(
        &self,
        connection: &WorkerLaunchConnection,
        runtime: &WorkerRuntime,
    ) -> Result<()> {
        self.selection.assert_runtime(runtime)?;
        if connection.same_runtime(runtime)
            && self.selection.records.iter().any(|record| {
                connection.has_viewer_identity(&RelayIdentity::new(
                    &self.selection.service,
                    Arc::clone(record),
                ))
            })
        {
            Ok(())
        } else {
            Err(WorkerReportError::Unconfirmed)
        }
    }
}
