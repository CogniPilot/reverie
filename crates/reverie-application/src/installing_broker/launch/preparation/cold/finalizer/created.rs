//! Fresh Created readback precedes any checked stopped-resource return. A
//! running record remains in its real registry; it is never rebuilt as Direct.
use super::*;
use reverie_host::worker_laptop::{CreatedStorageObservation, DirectStorageObservation};
pub(super) enum Observation {
    Direct(DirectStorageObservation),
    Created(CreatedStorageObservation),
}
impl Observation {
    pub(super) fn is_live(&self) -> bool {
        match self {
            Self::Direct(value) => value.is_live(),
            Self::Created(value) => value.is_live(),
        }
    }
}
impl Finalizer<'_> {
    pub(super) fn observe_storage(&mut self) -> Option<Observation> {
        if let (Some(created), Some(network)) = (self.owner.created(), self.owner.network()) {
            match network.observe_created_storage(created) {
                Ok(observation) => Some(Observation::Created(observation)),
                Err(error) => {
                    self.errors.push(error.into());
                    None
                }
            }
        } else {
            self.observe_direct_storage().map(Observation::Direct)
        }
    }
    pub(super) fn finish_storage(
        &mut self,
        observation: Observation,
        budget: CleanupBudget,
    ) -> Option<bool> {
        match observation {
            Observation::Direct(observation) => {
                self.finish_direct_storage(&observation, budget.phase(20_000))
            }
            Observation::Created(observation) => self.finish_created_storage(&observation, budget),
        }
    }
    fn finish_created_storage(
        &mut self,
        observation: &CreatedStorageObservation,
        budget: CleanupBudget,
    ) -> Option<bool> {
        if observation.is_live() {
            // Only an actual committed Started registry owner can outlive this
            // handler with live resources. An unregistered partial body cannot.
            let Some(started) = self.owner.started() else {
                self.errors
                    .push(ColdError::Refused("WORKER_COLD_LIVE_RESOURCE_UNREGISTERED"));
                return None;
            };
            let result = self.require_started_registration(started, budget);
            if let Err(error) = result {
                self.errors.push(error.into());
                return None;
            }
            return Some(true);
        }
        let Some(stopped) = &self.stopped else {
            self.errors
                .push(ColdError::Refused("WORKER_COLD_STOPPED_OWNER_REQUIRED"));
            return None;
        };
        let network = self.owner.network().expect("same Created resource");
        match network.restore_stopped_created(stopped, observation) {
            Ok(returned) => self.returned = Some(Resources::CreatedReturned(returned)),
            Err(error) => {
                self.errors.push(error.into());
                return None;
            }
        }
        let Some(Resources::CreatedReturned(returned)) = self.returned.take() else {
            unreachable!("same checked Created return");
        };
        match returned.finish_storage(budget.phase(20_000)) {
            Ok((retained, primary)) => {
                if let Some(primary) = primary {
                    self.body_causes.push(ColdError::Recorded(primary));
                }
                self.returned = Some(Resources::CreatedClosed);
                Some(retained)
            }
            Err(failure) => {
                self.returned = Some(Resources::CreatedReturnFailed(failure));
                self.errors
                    .push(ColdError::Refused("WORKER_COLD_CREATED_STORAGE_RETAINED"));
                None
            }
        }
    }
    fn require_started_registration(
        &self,
        started: &Arc<StartedLaptop>,
        budget: CleanupBudget,
    ) -> Result<(), GateError> {
        let scope = self.owner.scope();
        let lifecycle = budget.lifecycle(scope.preparing.broker())?;
        let selected = lifecycle.guard.iter().any(|entry| {
            entry.session == *scope.preparing.admitted.request().session()
                && matches!(&entry.owner, LaptopOwner::Started(actual) if Arc::ptr_eq(actual, started))
        });
        if !selected {
            return Err(GateError::Refused(
                "WORKER_COLD_STARTED_REGISTRATION_CHANGED",
            ));
        }
        Ok(())
    }
}
