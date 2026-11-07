use super::*;
#[must_use = "restore the same claim and both original observations"]
pub struct ReplacementStopRetainFailure {
    pub(super) claim: StorageClaim,
    pub(super) plan: ObservedCreatePlan,
    pub(super) process: ExistingProcessIncarnation,
    pub(super) cause: StorageWorkflowError,
}
impl ReplacementStopRetainFailure {
    pub fn into_parts(
        self: Box<Self>,
    ) -> (
        StorageClaim,
        ObservedCreatePlan,
        ExistingProcessIncarnation,
        StorageWorkflowError,
    ) {
        (self.claim, self.plan, self.process, self.cause)
    }
    pub fn cause(&self) -> &StorageWorkflowError {
        &self.cause
    }
}
#[must_use = "retain the same registered native owner through uncertainty"]
pub struct ReplacementStopReclaimFailure {
    pub(super) preparation: ReplacementStopPreparation,
    pub(super) cause: StorageWorkflowError,
}
impl ReplacementStopReclaimFailure {
    pub fn into_parts(self: Box<Self>) -> (ReplacementStopPreparation, StorageWorkflowError) {
        (self.preparation, self.cause)
    }
    pub fn cause(&self) -> &StorageWorkflowError {
        &self.cause
    }
}
impl std::fmt::Debug for ReplacementStopRetainFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("ReplacementStopRetainFailure")
            .field(&self.cause)
            .finish()
    }
}
impl std::fmt::Debug for ReplacementStopReclaimFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("ReplacementStopReclaimFailure")
            .field(&self.cause)
            .finish()
    }
}
impl std::fmt::Display for ReplacementStopRetainFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.cause.fmt(f)
    }
}
impl std::fmt::Display for ReplacementStopReclaimFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.cause.fmt(f)
    }
}
impl std::error::Error for ReplacementStopRetainFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.cause)
    }
}
impl std::error::Error for ReplacementStopReclaimFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.cause)
    }
}
