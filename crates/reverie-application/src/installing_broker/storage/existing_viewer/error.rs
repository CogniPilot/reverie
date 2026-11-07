use super::*;
#[derive(Debug)]
pub(in crate::installing_broker) enum ExistingStorageError {
    Storage(StorageWorkflowError),
    Host(LaptopError),
    Refused(&'static str),
}
impl From<StorageWorkflowError> for ExistingStorageError {
    fn from(error: StorageWorkflowError) -> Self {
        Self::Storage(error)
    }
}
impl From<LaptopError> for ExistingStorageError {
    fn from(error: LaptopError) -> Self {
        Self::Host(error)
    }
}
impl std::fmt::Display for ExistingStorageError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Storage(error) => error.fmt(out),
            Self::Host(error) => error.fmt(out),
            Self::Refused(code) => out.write_str(code),
        }
    }
}
impl std::error::Error for ExistingStorageError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Storage(error) => Some(error),
            Self::Host(error) => Some(error),
            Self::Refused(_) => None,
        }
    }
}
#[must_use = "restore the original resource and every actual observation"]
pub(in crate::installing_broker) struct ExistingStorageRetainFailure {
    pub(super) claim: StorageClaim,
    pub(super) inputs: Inputs,
    pub(super) error: ExistingStorageError,
}
impl ExistingStorageRetainFailure {
    pub(in crate::installing_broker) fn into_parts(
        self: Box<Self>,
    ) -> (
        StorageClaim,
        ObservedCreatePlan,
        WorkerRequest,
        ExistingLaptopInspection,
        LaunchReceiptObservation,
        ExistingStorageError,
    ) {
        let inputs = self.inputs;
        (
            self.claim,
            inputs.plan,
            inputs.request,
            inputs.inspected,
            inputs.receipt,
            self.error,
        )
    }
}
#[must_use = "unknown native work retains the SAME preparation, box and registry"]
pub(in crate::installing_broker) struct ExistingStorageReclaimFailure {
    pub(super) preparation: ExistingStoragePreparation,
    pub(super) error: ExistingStorageError,
}
impl ExistingStorageReclaimFailure {
    pub(in crate::installing_broker) fn into_parts(
        self: Box<Self>,
    ) -> (ExistingStoragePreparation, ExistingStorageError) {
        (self.preparation, self.error)
    }
}
