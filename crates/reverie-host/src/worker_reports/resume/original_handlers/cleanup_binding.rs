//! The original selection only: no admission, native action or closure grant.
use super::*;
use crate::worker_reports::terminal::RelayIdentity;

/// Pure provenance refusal. These checks perform no native acquisition or
/// close, and cannot retain a transport/database failure in a shared Gate.
#[derive(Clone, Copy, Debug)]
pub struct WorkerOriginalHandlersCleanupError;
impl WorkerOriginalHandlersCleanupError {
    pub fn code(&self) -> &'static str {
        "WORKER_ORIGINAL_HANDLER_BINDING_REFUSED"
    }
}
impl std::fmt::Display for WorkerOriginalHandlersCleanupError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for WorkerOriginalHandlersCleanupError {}
type BindingResult = std::result::Result<(), WorkerOriginalHandlersCleanupError>;

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
impl WorkerOriginalHandlersClosed {
    /// Same physically settled record selection; no native-resource closure.
    pub fn cleanup_binding(&self) -> WorkerOriginalHandlersCleanupBinding {
        WorkerOriginalHandlersCleanupBinding {
            selection: Arc::clone(&self.selection),
        }
    }
}
impl WorkerOriginalHandlersCleanupBinding {
    pub fn assert_same_selection(&self, other: &Self) -> BindingResult {
        if Arc::ptr_eq(&self.selection, &other.selection) {
            Ok(())
        } else {
            Err(WorkerOriginalHandlersCleanupError)
        }
    }
    /// Match the actual originating fleet Q, service and runtime. Identity
    /// survives EOF/cancellation; it does not establish current authority.
    pub fn assert_owner(
        &self,
        channel: &WorkerActorChannel,
        expected: &Arc<WorkerReportService>,
        runtime: &WorkerRuntime,
    ) -> BindingResult {
        if self.selection.purpose != SelectionPurpose::Fleet
            || !self.selection.same_runtime(runtime)
            || !Arc::ptr_eq(expected, &self.selection.service)
            || !Arc::ptr_eq(&channel.connection.record, &self.selection.own)
            || channel.purpose != Purpose::FleetMaintenanceWebsite
            || !Arc::ptr_eq(&channel.connection.service, expected)
        {
            return Err(WorkerOriginalHandlersCleanupError);
        }
        Ok(())
    }
    /// Match only this original typed J against the retained selection. The
    /// Gate must separately check its current transition, pending and target;
    /// this observation neither admits cleanup nor acknowledges settlement.
    pub fn assert_original(
        &self,
        connection: &WorkerLaunchConnection,
        runtime: &WorkerRuntime,
    ) -> BindingResult {
        if self.selection.same_runtime(runtime)
            && connection.same_runtime(runtime)
            && self.selection.records.iter().any(|record| {
                connection.has_viewer_identity(&RelayIdentity::new(
                    &self.selection.service,
                    Arc::clone(record),
                ))
            })
        {
            Ok(())
        } else {
            Err(WorkerOriginalHandlersCleanupError)
        }
    }
}
