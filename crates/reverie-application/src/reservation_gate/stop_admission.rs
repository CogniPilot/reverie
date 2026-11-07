//! The real unprotected Broker.stop allocation scope. Check_stop is a durable
//! fence, not process custody, stop authority, or global release evidence.
use super::*;
use reverie_core::worker_laptop::WorkerContainerName;

enum Scope {
    Owned(admission::Admission),
    Borrowed,
}
#[must_use = "finish or abort the actual same-thread stop allocation scope"]
pub(crate) struct OrdinaryStopAdmission {
    gate: Arc<Inner>,
    active: Arc<Active>,
    scope: Scope,
}
impl ReservationGate {
    /// This closed consumer never runs launch SID/image/GPU/creation checks.
    /// Its installed origin and native ceiling come from the real broker.
    pub(crate) fn admit_ordinary_stop(
        &self,
        installed: &Arc<crate::installing_broker::InstalledWorker>,
        target: &WorkerContainerName,
        native_ceiling: Option<Instant>,
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
            let admission = self.inner.admit_stop(native_ceiling)?;
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
        };
        let checked = scope
            .tighten_native_ceiling(native_ceiling)
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
    /// A global first-stop bound may tighten the existing original context; it
    /// cannot reset the operation clock, replace the observer or extend a bound.
    pub(crate) fn tighten_native_ceiling(&self, ceiling: Option<Instant>) -> Result<()> {
        self.assert_origin(&self.gate.installed)?;
        let mut deadline = self
            .active
            .deadline
            .lock()
            .map_err(|_| GateError::Refused("RESERVATION_ADMISSION_UNAVAILABLE"))?;
        *deadline = [*deadline, ceiling].into_iter().flatten().min();
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
