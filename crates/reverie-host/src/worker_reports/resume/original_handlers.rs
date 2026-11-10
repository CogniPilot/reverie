//! SAME-Q transport component only. The application must first authorize ALL
//! other original handlers and publish its durable admission fence. No fleet
//! consent, provider stop, storage release or global drained grant is minted.
use super::*;
use std::rc::Rc;
mod cleanup_binding;
mod progress;
pub use cleanup_binding::{
    WorkerOriginalHandlersCleanupBinding, WorkerOriginalHandlersCleanupError,
};
type DrainResult<T> = std::result::Result<T, Rc<WorkerReportError>>;

struct Selected {
    interrupted: bool,
    reconciled: bool,
    primary: Option<Rc<WorkerReportError>>,
    cleanup: Option<Rc<WorkerReportError>>,
}
struct Selection {
    service: Arc<WorkerReportService>,
    own: Arc<Record>,
    records: Vec<Arc<Record>>,
}
struct Originals {
    selection: Arc<Selection>,
    selected: Vec<Selected>,
    end: Instant,
}
impl Selection {
    fn same_runtime(&self, runtime: &WorkerRuntime) -> bool {
        Arc::ptr_eq(&self.service.engine, runtime.installed_engine())
    }
    fn assert_runtime(&self, runtime: &WorkerRuntime) -> Result<()> {
        if self.same_runtime(runtime) {
            Ok(())
        } else {
            Err(WorkerReportError::Unconfirmed)
        }
    }
}
#[must_use = "retain original records and every typed failure until known component settlement"]
pub struct WorkerOriginalHandlersDrain {
    originals: Option<Originals>,
    admitted: bool,
    interrupted: bool,
    settled: bool,
    primary: Option<Rc<WorkerReportError>>,
    cleanup: Option<Rc<WorkerReportError>>,
}
/// Known handler/socket/Hold component observations, never native resource or
/// fleet closure. Earlier primary and cleanup diagnostics remain available.
pub struct WorkerOriginalHandlersClosed {
    primary: Option<Rc<WorkerReportError>>,
    cleanup: Option<Rc<WorkerReportError>>,
    causes: Vec<Rc<WorkerReportError>>,
}
impl WorkerActorChannel {
    /// Inert snapshot of this SAME service's original records, excluding only
    /// the actual Q Record allocation. Capture neither interrupts nor joins.
    pub fn retain_other_original_handlers(
        &self,
        expected: &Arc<WorkerReportService>,
        runtime: &WorkerRuntime,
        end: Instant,
    ) -> Result<WorkerOriginalHandlersDrain> {
        self.assert_service(expected)?;
        if self.purpose != Purpose::FleetMaintenanceWebsite
            || self.close != ClosePhase::Open
            || !self.connection.same_runtime(runtime)
            || self.opaque()
        {
            return Err(WorkerReportError::Unconfirmed);
        }
        self.require_connected()?;
        let records = expected.records.try_lock().map_err(|error| {
            if matches!(error, TryLockError::Poisoned(_)) {
                expected.opaque.store(true, Ordering::Release);
            }
            WorkerReportError::Unconfirmed
        })?;
        if !records
            .iter()
            .any(|row| Arc::ptr_eq(row, &self.connection.record))
        {
            return Err(WorkerReportError::Unconfirmed);
        }
        let records = records
            .iter()
            .filter(|row| !Arc::ptr_eq(row, &self.connection.record))
            .cloned()
            .collect::<Vec<_>>();
        let selected = records
            .iter()
            .map(|_| Selected {
                interrupted: false,
                reconciled: false,
                primary: None,
                cleanup: None,
            })
            .collect();
        Ok(WorkerOriginalHandlersDrain {
            originals: Some(Originals {
                selection: Arc::new(Selection {
                    service: Arc::clone(expected),
                    own: Arc::clone(&self.connection.record),
                    records,
                }),
                selected,
                end,
            }),
            admitted: false,
            interrupted: false,
            settled: false,
            primary: None,
            cleanup: None,
        })
    }
}
impl WorkerOriginalHandlersDrain {
    fn originals(&self) -> &Originals {
        self.originals
            .as_ref()
            .expect("originals retained until consuming closed observation")
    }
    fn assert_runtime(&self, runtime: &WorkerRuntime) -> Result<()> {
        self.originals().selection.assert_runtime(runtime)
    }
    /// Original deadline, dynamically clipped by the SAME engine's first stop.
    /// Reading this value grants no permission to interrupt or settle.
    pub fn deadline(&self, runtime: &WorkerRuntime) -> Result<Instant> {
        self.assert_runtime(runtime)?;
        let originals = self.originals();
        Ok(originals
            .selection
            .service
            .engine
            .stop_deadline()
            .map_or(originals.end, |stop| stop.min(originals.end)))
    }
    pub fn primary_error(&self) -> Option<&Rc<WorkerReportError>> {
        self.primary.as_ref()
    }
    pub fn cleanup_error(&self) -> Option<&Rc<WorkerReportError>> {
        self.cleanup.as_ref()
    }
    /// Consuming component-only result retains every distinct original typed
    /// diagnostic even if all selected handler records are now known settled.
    pub fn into_closed(mut self) -> std::result::Result<WorkerOriginalHandlersClosed, Box<Self>> {
        if !self.settled {
            return Err(Box::new(self));
        }
        let originals = self.originals.take().expect("same originals consumed once");
        let causes = originals
            .selected
            .into_iter()
            .flat_map(|row| [row.primary, row.cleanup])
            .flatten()
            .collect();
        Ok(WorkerOriginalHandlersClosed {
            primary: self.primary.take(),
            cleanup: self.cleanup.take(),
            causes,
        })
    }
}
impl WorkerOriginalHandlersClosed {
    pub fn primary_error(&self) -> Option<&Rc<WorkerReportError>> {
        self.primary.as_ref()
    }
    pub fn cleanup_error(&self) -> Option<&Rc<WorkerReportError>> {
        self.cleanup.as_ref()
    }
    pub fn original_causes(&self) -> &[Rc<WorkerReportError>] {
        &self.causes
    }
}
impl Drop for WorkerOriginalHandlersDrain {
    fn drop(&mut self) {
        if !self.settled || self.primary.is_some() || self.cleanup.is_some() {
            // Losing the new component owner never acknowledges old resources
            // or discards the first typed diagnostics after known settlement.
            std::mem::forget(self.originals.take());
            std::mem::forget(self.primary.take());
            std::mem::forget(self.cleanup.take());
        }
    }
}
