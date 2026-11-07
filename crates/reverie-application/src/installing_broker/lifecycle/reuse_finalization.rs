//! Actual reuse cleanup, not a public lifecycle/storage permission.
use super::*;
use std::time::Instant;
#[cfg(test)]
mod tests;
impl InstalledWorker {
    pub(in crate::installing_broker) fn cleanup_lifecycle(
        &self,
        runtime: &reverie_host::worker_runtime::WorkerRuntime,
    ) -> Result<LaptopLifecycle<'_>, GateError> {
        let observed = runtime.stop_deadline();
        #[cfg(test)]
        tests::captured(observed);
        let poison = if observed.is_none() {
            "WORKER_BROKER_LIFECYCLE_UNAVAILABLE"
        } else {
            "WORKER_BROKER_LOCK_UNAVAILABLE"
        };
        self.cleanup_lifecycle_selected(runtime, None, poison)
    }
    pub(in crate::installing_broker) fn cleanup_lifecycle_until(
        &self,
        runtime: &reverie_host::worker_runtime::WorkerRuntime,
        end: Instant,
    ) -> Result<LaptopLifecycle<'_>, GateError> {
        self.cleanup_lifecycle_selected(runtime, Some(end), "WORKER_BROKER_LOCK_UNAVAILABLE")
    }
    fn cleanup_lifecycle_selected(
        &self,
        runtime: &reverie_host::worker_runtime::WorkerRuntime,
        ceiling: Option<Instant>,
        poison: &'static str,
    ) -> Result<LaptopLifecycle<'_>, GateError> {
        loop {
            match self.laptops.try_lock() {
                Ok(guard) => return Ok(LaptopLifecycle { owner: self, guard }),
                Err(std::sync::TryLockError::Poisoned(_)) => {
                    return Err(GateError::Refused(poison));
                }
                Err(std::sync::TryLockError::WouldBlock) => {}
            }
            // The initial None observation cannot grant an unbounded wait
            // after the SAME Runtime publishes its original first-stop end.
            // Component ceilings remain original and are never refreshed.
            std::thread::sleep(lifecycle_pause(ceiling, runtime.stop_deadline())?);
        }
    }
}
fn lifecycle_pause(
    ceiling: Option<Instant>,
    stop: Option<Instant>,
) -> Result<std::time::Duration, GateError> {
    let end = match (ceiling, stop) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (Some(a), None) | (None, Some(a)) => Some(a),
        (None, None) => None,
    };
    let Some(end) = end else {
        return Ok(std::time::Duration::from_millis(1));
    };
    let remaining = end.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(GateError::Refused("WORKER_BROKER_LOCK_UNAVAILABLE"));
    }
    Ok(remaining.min(std::time::Duration::from_millis(1)))
}
impl LaptopLifecycle<'_> {
    pub(in crate::installing_broker) fn capture_reuse_registration(
        &self,
        session: &ProfileSessionId,
    ) -> Option<Arc<recovered::RecoveredOffice>> {
        let entry = self.guard.iter().find(|entry| &entry.session == session)?;
        match &entry.owner {
            LaptopOwner::Recovered(owner) => Some(owner.office.clone()),
            LaptopOwner::Started(owner) => Some(owner.office.clone()),
            #[cfg(test)]
            LaptopOwner::Modeled => None,
        }
    }
    /// Close only the original registered phone before removing its record.
    /// Failure leaves that exact registration retained rather than forgetting
    /// an unresolved Office producer before physical storage consumption.
    pub(in crate::installing_broker) fn close_reuse_registration(
        &mut self,
        token: &ActiveLaunchToken<'_>,
        name: &WorkerContainerName,
        original: Option<&Arc<recovered::RecoveredOffice>>,
        end: Instant,
    ) -> Result<(), storage::StorageWorkflowError> {
        self.close_reuse_registration_with_budget(token, name, original, Some(end))
    }
    pub(in crate::installing_broker) fn close_reuse_registration_for_worker(
        &mut self,
        token: &ActiveLaunchToken<'_>,
        name: &WorkerContainerName,
        original: Option<&Arc<recovered::RecoveredOffice>>,
    ) -> Result<(), storage::StorageWorkflowError> {
        self.close_reuse_registration_with_budget(token, name, original, None)
    }
    fn close_reuse_registration_with_budget(
        &mut self,
        token: &ActiveLaunchToken<'_>,
        name: &WorkerContainerName,
        original: Option<&Arc<recovered::RecoveredOffice>>,
        ceiling: Option<Instant>,
    ) -> Result<(), storage::StorageWorkflowError> {
        if !self.belongs_to(token.owner) {
            return Err(GateError::Refused("WORKER_BROKER_ACTIVE_ORIGIN").into());
        }
        let Some(index) = self
            .guard
            .iter()
            .position(|entry| entry.session == token.session)
        else {
            return Ok(());
        };
        if self.guard[index].name != *name {
            return Err(GateError::Refused("WORKER_REUSE_REGISTRATION_CHANGED").into());
        }
        match &self.guard[index].owner {
            LaptopOwner::Recovered(owner) => {
                if !original.is_some_and(|original| Arc::ptr_eq(original, &owner.office)) {
                    return Err(GateError::Refused("WORKER_REUSE_REGISTRATION_CHANGED").into());
                }
                // Source's default Office grace starts only at this actual
                // phase, after admission, lifecycle acquisition and identity.
                // The Office owner still clips it to the live first-stop end.
                let end =
                    ceiling.unwrap_or_else(|| Instant::now() + std::time::Duration::from_secs(2));
                owner.office.close_for_stopped_source(end)?;
            }
            LaptopOwner::Started(owner) => {
                if !original.is_some_and(|original| Arc::ptr_eq(original, &owner.office)) {
                    return Err(GateError::Refused("WORKER_REUSE_REGISTRATION_CHANGED").into());
                }
                // Match the recovered owner: start the worker phone grace
                // only after the same registration and lifecycle checks.
                let end =
                    ceiling.unwrap_or_else(|| Instant::now() + std::time::Duration::from_secs(2));
                owner.office.close_for_stopped_source(end)?;
            }
            #[cfg(test)]
            LaptopOwner::Modeled => {
                return Err(GateError::Refused(
                    "WORKER_MODELED_REGISTRATION_IS_NOT_RECOVERY_OWNER",
                )
                .into());
            }
        }
        self.guard.remove(index);
        Ok(())
    }
}
impl ActiveLaunchToken<'_> {
    /// Called only by the actual finalizer after known resource transfer/close
    /// and checked socket closure. Default Drop never releases this hold.
    pub(in crate::installing_broker) fn release_handler_hold(
        &mut self,
        end: Instant,
    ) -> Result<(), reverie_host::worker_reports::WorkerReportError> {
        self.hold.release(end)
    }
    pub(in crate::installing_broker) fn release_handler_hold_for_worker(
        &mut self,
    ) -> Result<(), reverie_host::worker_reports::WorkerReportError> {
        self.hold.release_for_worker()
    }
}
