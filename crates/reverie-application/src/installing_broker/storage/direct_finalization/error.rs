use super::*;

pub(in crate::installing_broker) struct DirectStorageRetainFailure {
    pub(super) claim: StorageClaim,
    pub(super) plan: ObservedCreatePlan,
    pub(super) cause: StorageWorkflowError,
}
impl DirectStorageRetainFailure {
    pub(in crate::installing_broker) fn into_parts(
        self: Box<Self>,
    ) -> (StorageClaim, ObservedCreatePlan, StorageWorkflowError) {
        (self.claim, self.plan, self.cause)
    }
}
pub(super) enum Owner {
    Preparing(Box<DirectStoragePreparation>),
    Returned(Box<Returned>),
}
pub(in crate::installing_broker) struct DirectStorageFinishFailure {
    pub(super) owner: Owner,
    pub(super) cause: StorageWorkflowError,
}
impl DirectStorageFinishFailure {
    pub(in crate::installing_broker) fn cause(&self) -> &StorageWorkflowError {
        &self.cause
    }
}
impl std::fmt::Debug for DirectStorageRetainFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("DirectStorageRetainFailure")
            .field(&self.cause)
            .finish()
    }
}
impl std::fmt::Debug for DirectStorageFinishFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut value = f.debug_struct("DirectStorageFinishFailure");
        match &self.owner {
            Owner::Preparing(owner) => {
                match &owner.destination {
                    Destination::Legacy { .. } => value.field("phase", &"legacy native"),
                    Destination::Registered { newly_claimed, .. } => value
                        .field("phase", &"registered native")
                        .field("newly_claimed", newly_claimed),
                };
            }
            Owner::Returned(owner) => {
                value
                    .field("phase", &"physical")
                    .field("storage", owner.claim.paths())
                    .field("live_data", &owner.decision.live);
            }
        };
        value.field("cause", &self.cause).finish()
    }
}
