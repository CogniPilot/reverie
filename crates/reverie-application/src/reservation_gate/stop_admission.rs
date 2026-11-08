//! The real unprotected Broker.stop allocation scope. Check_stop is a durable
//! fence, not process custody, stop authority, or global release evidence.
use super::*;
use reverie_core::worker_laptop::WorkerContainerName;
use reverie_host::worker_runtime::{WorkerRuntime, WorkerStopBudget};

enum Scope {
    Owned(admission::Admission),
    Borrowed,
}
pub(crate) struct FleetStopAdmission {
    gate: Arc<Inner>,
    admission: admission::Admission,
}
impl ReservationGate {
    pub(crate) fn admit_fleet_stop(
        &self,
        installed: &Arc<crate::installing_broker::InstalledWorker>,
        budget: &WorkerStopBudget,
    ) -> Result<FleetStopAdmission> {
        need(
            Arc::ptr_eq(installed, &self.inner.installed),
            "WORKER_STOP_ADMISSION_ORIGIN",
        )?;
        let admission = self.inner.admit_stop(Some(budget))?;
        Ok(FleetStopAdmission {
            gate: self.inner.clone(),
            admission,
        })
    }
}
impl FleetStopAdmission {
    pub(crate) fn check_target(&self, target: &WorkerContainerName) -> Result<()> {
        self.gate.check_ordinary_stop(target.as_str())
    }
    pub(crate) fn close(self) -> Result<()> {
        self.admission.finish()
    }
    pub(crate) fn abort(self) -> Result<()> {
        self.admission.abort()
    }
}
#[must_use = "finish or abort the actual same-thread stop allocation scope"]
pub(crate) struct OrdinaryStopAdmission {
    gate: Arc<Inner>,
    active: Arc<Active>,
    scope: Scope,
    budget: Option<WorkerStopBudget>,
}
impl ReservationGate {
    /// This closed consumer never runs launch SID/image/GPU/creation checks.
    /// Its installed origin and native ceiling come from the real broker.
    pub(crate) fn admit_ordinary_stop(
        &self,
        installed: &Arc<crate::installing_broker::InstalledWorker>,
        target: &WorkerContainerName,
        native_budget: Option<&WorkerStopBudget>,
    ) -> Result<OrdinaryStopAdmission> {
        need(
            Arc::ptr_eq(installed, &self.inner.installed),
            "WORKER_STOP_ADMISSION_ORIGIN",
        )?;
        let borrowed = self
            .inner
            .state
            .lock()
            .map_err(|_| GateError::Refused("RESERVATION_ADMISSION_UNAVAILABLE"))?
            .active
            .as_ref()
            .filter(|active| {
                active.thread == std::thread::current().id() && active.process == std::process::id()
            })
            .cloned();
        let (scope, active) = if let Some(active) = borrowed {
            (Scope::Borrowed, active)
        } else {
            let admission = self.inner.admit_stop(native_budget)?;
            let active = match self.inner.held(None) {
                Ok(active) => active,
                Err(cause) => return admission.conclude(Err(cause)),
            };
            (Scope::Owned(admission), active)
        };
        let scope = OrdinaryStopAdmission {
            gate: self.inner.clone(),
            active,
            scope,
            budget: native_budget.cloned(),
        };
        let checked = scope
            .inherit_native_budget(native_budget)
            .and_then(|()| scope.gate.check_ordinary_stop(target.as_str()));
        match checked {
            Ok(()) => Ok(scope),
            Err(cause) => scope.fail(cause),
        }
    }
}
impl OrdinaryStopAdmission {
    pub(crate) fn assert_origin(
        &self,
        installed: &Arc<crate::installing_broker::InstalledWorker>,
    ) -> Result<()> {
        need(
            Arc::ptr_eq(installed, &self.gate.installed),
            "WORKER_STOP_ADMISSION_ORIGIN",
        )?;
        let active = self.gate.held(None)?;
        need(
            Arc::ptr_eq(&active, &self.active),
            "RESERVATION_ADMISSION_LOCK_REQUIRED",
        )
    }
    pub(crate) fn assert_runtime(&self, runtime: &WorkerRuntime) -> Result<()> {
        need(
            self.budget
                .as_ref()
                .is_some_and(|budget| budget.same_runtime(runtime)),
            "WORKER_STOP_ADMISSION_ORIGIN",
        )
    }
    /// Install only the actual service's read-only first-stop view. An outer
    /// operation budget and the same observer/census origin remain unchanged.
    fn inherit_native_budget(&self, budget: Option<&WorkerStopBudget>) -> Result<()> {
        self.assert_origin(&self.gate.installed)?;
        if let Some(budget) = budget {
            self.active
                .context
                .lock()
                .map_err(|_| GateError::Refused("RESERVATION_ADMISSION_UNAVAILABLE"))?
                .inherit_worker_stop_budget(budget)?;
        }
        Ok(())
    }
    pub(crate) fn close(self) -> Result<()> {
        match self.scope {
            Scope::Owned(admission) => admission.finish(),
            Scope::Borrowed => self.assert_origin(&self.gate.installed),
        }
    }
    pub(crate) fn abort(self) -> Result<()> {
        match self.scope {
            Scope::Owned(admission) => admission.abort(),
            Scope::Borrowed => self.assert_origin(&self.gate.installed),
        }
    }
    pub(crate) fn fail<T>(self, cause: GateError) -> Result<T> {
        finalized(Err(cause), self.abort())
    }
}
