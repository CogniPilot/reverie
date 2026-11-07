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
        let Some(end) = observed else {
            return self.lifecycle();
        };
        self.cleanup_lifecycle_until(end)
    }
    pub(in crate::installing_broker) fn cleanup_lifecycle_until(
        &self,
        end: Instant,
    ) -> Result<LaptopLifecycle<'_>, GateError> {
        loop {
            match self.laptops.try_lock() {
                Ok(guard) => return Ok(LaptopLifecycle { owner: self, guard }),
                Err(std::sync::TryLockError::Poisoned(_)) => {
                    return Err(GateError::Refused("WORKER_BROKER_LOCK_UNAVAILABLE"));
                }
                Err(std::sync::TryLockError::WouldBlock) => {}
            }
            let now = Instant::now();
            if now >= end {
                return Err(GateError::Refused("WORKER_BROKER_LOCK_UNAVAILABLE"));
            }
            std::thread::sleep(
                end.duration_since(now)
                    .min(std::time::Duration::from_millis(1)),
            );
        }
    }
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
