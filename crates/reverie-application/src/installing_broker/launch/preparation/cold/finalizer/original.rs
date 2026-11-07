//! Original reusable prefix stop before any native viewer has been retained.
//! The actual sealed observation and same resource enter the existing owner.
use super::*;
impl Finalizer<'_> {
    pub(super) fn stop_classified_original(&mut self, budget: CleanupBudget) {
        if self.completed != Some(true) || !matches!(&self.owner, Owner::Classified(_)) {
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
        let Some(Resources::Legacy(native)) = slot else {
            unreachable!("actual stop owner");
        };
        native.stop_after_admission()?;
        let Some(Resources::Legacy(native)) = slot.take() else {
            unreachable!("same stop owner");
        };
        match native.reclaim(budget.phase(20_000)) {
            Ok(returned) => {
                let (storage, plan, _inspection, removal) = returned.into_cold_parts();
                *slot = Some(Resources::Stopped(Stopped {
                    storage,
                    plan,
                    removal: Some(removal),
                }));
                Ok(())
            }
            Err(failure) => {
                let (native, cause) = failure.into_parts();
                *slot = Some(Resources::Legacy(native));
                Err(cause.into())
            }
        }
    }
}
