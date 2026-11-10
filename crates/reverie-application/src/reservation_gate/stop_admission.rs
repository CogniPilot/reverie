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
    /// Same-record fleet stop only after actual authorized Q and physical
    /// settlement of its bound original handlers. No launch or release grant.
    pub(crate) fn admit_transition_fleet_stop(
        &self,
        authorization: &mut crate::installing_broker::resource_actor::AuthenticatedFleetMaintenance<
            '_,
        >,
        fence: &PoolTransitionFence,
        closed: &reverie_host::worker_reports::WorkerOriginalHandlersClosed,
        installed: &Arc<crate::installing_broker::InstalledWorker>,
        budget: &WorkerStopBudget,
    ) -> Result<FleetStopAdmission> {
        authorization.assert_fleet_stop_gate(self)?;
        fence.assert_gate(self)?;
        fence.assert_selection(authorization.selection())?;
        need(
            Arc::ptr_eq(installed, &self.inner.installed),
            "WORKER_STOP_ADMISSION_ORIGIN",
        )?;
        let purpose = fence.legacy_fleet_cleanup(closed, authorization.fleet_stop_targets()?)?;
        let admission = self.inner.admit_transition_entry(
            purpose,
            budget,
            authorization.fleet_stop_deadline(),
        )?;
        let owned = FleetStopAdmission {
            gate: Arc::clone(&self.inner),
            admission,
        };
        let body = (|| {
            authorization.assert_fleet_stop_gate(self)?;
            let rows = self.inner.guard(None)?;
            authorization.assert_fleet_stop_inventory(&rows)?;
            authorization.assert_fleet_stop_gate(self)?;
            owned.check_transition_history()
        })();
        match body {
            Ok(()) => Ok(owned),
            Err(primary) => finalized(Err(primary), owned.abort()),
        }
    }
    /// Same ordinary allocation/native guards, but the supervisor skips an
    /// actually busy entry instead of blocking the main service accept loop.
    pub(crate) fn try_admit_service_stop(
        &self,
        installed: &Arc<crate::installing_broker::InstalledWorker>,
        budget: &WorkerStopBudget,
        target: &WorkerContainerName,
        end: std::time::Instant,
    ) -> Result<Option<FleetStopAdmission>> {
        need(
            Arc::ptr_eq(installed, &self.inner.installed),
            "WORKER_STOP_ADMISSION_ORIGIN",
        )?;
        let Some(admission) = self.inner.admit_ready_stop(end, budget)? else {
            return Ok(None);
        };
        let owned = FleetStopAdmission {
            gate: self.inner.clone(),
            admission,
        };
        match owned.check_target(target) {
            Ok(()) => Ok(Some(owned)),
            Err(primary) => finalized(Err(primary), owned.abort()),
        }
    }
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
        if let Some(cleanup) = &self.gate.held(None)?.original_cleanup {
            cleanup.assert_target(target)?;
        }
        self.gate.check_ordinary_stop(target.as_str())?;
        self.check_transition_history()
    }
    pub(crate) fn close(self) -> Result<()> {
        let checked = self.check_transition_history();
        finalized(checked, self.admission.finish())
    }
    pub(crate) fn abort(self) -> Result<()> {
        self.admission.abort()
    }
    fn check_transition_history(&self) -> Result<()> {
        self.gate
            .held(None)?
            .original_cleanup
            .as_ref()
            .map_or(Ok(()), |cleanup| cleanup.assert_fleet_history(&self.gate))
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
        // Ordinary callers cannot inherit an original-handler cleanup purpose
        // merely because the same thread currently owns that admission.
        self.inner.assert_no_pool_transition()?;
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
impl ReservationGate {
    pub(crate) fn admit_original_handler_cleanup(
        &self,
        installed: &Arc<crate::installing_broker::InstalledWorker>,
        connection: &reverie_host::worker_reports::WorkerLaunchConnection,
        target: &WorkerContainerName,
        runtime: &WorkerRuntime,
    ) -> Result<OrdinaryStopAdmission> {
        need(
            Arc::ptr_eq(installed, &self.inner.installed) && connection.same_runtime(runtime),
            "WORKER_STOP_ADMISSION_ORIGIN",
        )?;
        let budget = runtime.stop_budget();
        let Some(cleanup) = self.inner.original_cleanup(connection, target, runtime)? else {
            return self.admit_ordinary_stop(installed, target, Some(&budget));
        };
        cleanup.assert_target(target)?;
        let admission = self.inner.admit_original_cleanup(cleanup, &budget)?;
        let active = match self.inner.held(None) {
            Ok(active) => active,
            Err(cause) => return admission.conclude(Err(cause)),
        };
        let scope = OrdinaryStopAdmission {
            gate: self.inner.clone(),
            active,
            scope: Scope::Owned(admission),
            budget: Some(budget),
        };
        match scope.gate.check_ordinary_stop(target.as_str()) {
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
