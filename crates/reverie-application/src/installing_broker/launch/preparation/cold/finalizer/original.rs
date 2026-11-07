//! Original reusable prefix stop before any native viewer has been retained.
//! The actual sealed observation and same resource enter the existing owner.
use super::*;
impl Finalizer<'_> {
    pub(super) fn stop_returned_original(&mut self, budget: CleanupBudget) {
        let Some(completed) = self.completed else {
            return;
        };
        if self.owner.created().is_some()
            || !matches!(&self.owner, Owner::Body(_))
            || !self.owner.stop_required(completed)
        {
            return;
        }
        let Some(target) = self.target.clone() else {
            self.errors
                .push(ColdError::Refused("WORKER_COLD_STOP_TARGET_REQUIRED"));
            return;
        };
        let broker = self.owner.scope().preparing.broker();
        let admission = match broker.admit_ordinary_stop(&target) {
            Ok(admission) => admission,
            Err(error) => {
                self.errors.push(error.into());
                return;
            }
        };
        let body = admission
            .assert_broker(broker)
            .and_then(|()| admission.assert_target(&target))
            .map_err(ColdError::from)
            .and_then(|()| self.stop_returned_resource(budget));
        let closed = if body.is_ok() {
            admission.close()
        } else {
            admission.abort()
        };
        if let Err(error) = body {
            self.errors.push(error);
        }
        if let Err(error) = closed {
            self.errors.push(error.into());
        }
    }
    fn stop_returned_resource(&mut self, budget: CleanupBudget) -> Result<(), ColdError> {
        let slot = self.owner.resource_slot().expect("actual body resources");
        let resources = slot.take().expect("same retained resource phase");
        let (storage, plan, remainder) = match resources {
            Resources::Direct(input) => (
                input.storage,
                input.plan,
                FinalStorageRemainder::Direct(input.target),
            ),
            Resources::Stopped(input) => (
                input.storage,
                input.plan,
                FinalStorageRemainder::Stopped(input.removal),
            ),
            Resources::Returned(input) if input.guard.is_none() => (
                input.storage,
                input.plan,
                FinalStorageRemainder::Returned(input.phone),
            ),
            other => {
                *slot = Some(other);
                return Err(ColdError::Refused("WORKER_COLD_ORIGINAL_RESOURCE_RETAINED"));
            }
        };
        match storage.retain_unobserved_ordinary_stop(plan) {
            Ok(native) => *slot = Some(Resources::Legacy(native)),
            Err(failure) => {
                let (storage, plan, _observation, cause) = failure.into_parts();
                *slot = Some(remainder.restore(storage, plan));
                return Err(cause.into());
            }
        }
        self.original_remainder = Some(remainder);
        let stopped = run_ordinary_cleanup(slot, budget)?;
        let remainder = self
            .original_remainder
            .take()
            .expect("same actual remainder");
        let phone = match remainder {
            FinalStorageRemainder::Returned(phone) => phone,
            _ => None,
        };
        *slot = Some(Resources::Returned(ReturnedStorage {
            storage: stopped.storage,
            plan: stopped.plan,
            guard: None,
            phone,
        }));
        Ok(())
    }
    pub(super) fn stop_classified_original(&mut self, budget: CleanupBudget) {
        if self.completed != Some(true)
            || !self.owner.stop_required(true)
            || !matches!(&self.owner, Owner::Classified(_))
        {
            return;
        }
        let Some(target) = self.target.clone() else {
            self.errors
                .push(ColdError::Refused("WORKER_COLD_STOP_TARGET_REQUIRED"));
            return;
        };
        let broker = self.owner.scope().preparing.broker();
        let admission = match broker.admit_ordinary_stop(&target) {
            Ok(admission) => admission,
            Err(error) => {
                self.errors.push(error.into());
                return;
            }
        };
        let body = admission
            .assert_broker(broker)
            .and_then(|()| admission.assert_target(&target))
            .map_err(ColdError::from)
            .and_then(|()| self.stop_classified_resource(budget));
        let closed = if body.is_ok() {
            admission.close()
        } else {
            admission.abort()
        };
        if let Err(error) = body {
            self.errors.push(error);
        }
        if let Err(error) = closed {
            self.errors.push(error.into());
        }
    }
    fn stop_classified_resource(&mut self, budget: CleanupBudget) -> Result<(), ColdError> {
        let slot = self.owner.resource_slot().expect("actual classified owner");
        let Some(Resources::OriginalCleanup {
            storage,
            plan,
            inspection,
        }) = slot.take()
        else {
            unreachable!("original one-shot classified cleanup");
        };
        match storage.retain_ordinary_stop(plan, inspection) {
            Ok(native) => *slot = Some(Resources::Legacy(native)),
            Err(failure) => {
                let (storage, plan, inspection, cause) = failure.into_parts();
                *slot = Some(Resources::OriginalCleanup {
                    storage,
                    plan,
                    inspection: inspection.expect("same actual observed input"),
                });
                return Err(cause.into());
            }
        }
        let stopped = run_ordinary_cleanup(slot, budget)?;
        *slot = Some(Resources::Stopped(stopped));
        Ok(())
    }
}
fn run_ordinary_cleanup(
    slot: &mut Option<Resources>,
    budget: CleanupBudget,
) -> Result<Stopped, ColdError> {
    let Some(Resources::Legacy(native)) = slot else {
        unreachable!("same actual ordinary owner");
    };
    let body = native.stop_after_admission().map_err(ColdError::from);
    let end = budget.phase(20_000);
    let settled = native.settle_native(end).map_err(ColdError::from);
    match (body, settled) {
        (Ok(()), Ok(())) => {}
        (Err(primary), Ok(())) | (Ok(()), Err(primary)) => return Err(primary),
        (Err(primary), Err(secondary)) => return Err(error::finalized(primary, secondary)),
    }
    let Some(Resources::Legacy(native)) = slot.take() else {
        unreachable!("same actual ordinary owner");
    };
    match native.reclaim(end) {
        Ok(returned) => {
            let (storage, plan, _inspection, removal) = returned.into_cold_parts();
            Ok(Stopped {
                storage,
                plan,
                removal: Some(removal),
            })
        }
        Err(failure) => {
            let (native, cause) = failure.into_parts();
            *slot = Some(Resources::Legacy(native));
            Err(cause.into())
        }
    }
}
