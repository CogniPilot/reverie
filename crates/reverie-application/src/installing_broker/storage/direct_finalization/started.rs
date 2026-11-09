//! An early later-J finally retains the same registered Created resource.
//! No Box-only Direct owner or replacement observation is manufactured.
use super::*;
use crate::installing_broker::storage::started::StartedClaim;
use reverie_host::worker_laptop::StartedStorageFinalizer;

pub(super) struct Finalization {
    claim: Box<StartedClaim>,
    native: StartedStorageFinalizer,
}
pub(super) fn retain(
    claim: Box<StartedClaim>,
    plan: ObservedCreatePlan,
) -> Result<Box<Finalization>, Box<DirectStorageRetainFailure>> {
    let mut plan = Some(plan);
    let result = (|| {
        let _entry = claim.stop_entry()?;
        claim
            .destination
            .registry()
            .runtime
            .retain_started_final_storage(&claim.owner.created, &mut plan, &claim.connection)
            .map_err(StorageWorkflowError::from)
    })();
    match result {
        Ok(native) => Ok(Box::new(Finalization { claim, native })),
        Err(cause) => Err(Box::new(DirectStorageRetainFailure {
            claim: StorageClaim {
                state: ClaimState::Started(claim),
            },
            plan: plan.expect("pure refusal retains original observation"),
            cause,
        })),
    }
}
impl Finalization {
    pub(super) fn observe(&mut self) -> Result<DirectStorageObservation, StorageWorkflowError> {
        // Validate the original entry, then release the global guard before
        // the actual fixed native read on this one retained Host record.
        {
            let _entry = self.claim.stop_entry()?;
        }
        Ok(self
            .native
            .observe(&self.claim.destination.registry().runtime)?)
    }
    pub(super) fn finish_live(
        &mut self,
        observation: &DirectStorageObservation,
    ) -> Result<ObservedCreatePlan, StorageWorkflowError> {
        let _entry = self.claim.stop_entry()?;
        Ok(self
            .native
            .finish_live(&self.claim.destination.registry().runtime, observation)?)
    }
}
