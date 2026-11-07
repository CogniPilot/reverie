use super::*;

pub struct DirectStorageRetainFailure {
    pub(super) storage: Box<LaunchStorage>,
    pub(super) plan: ObservedCreatePlan,
    pub(super) cause: LaptopError,
}
impl DirectStorageRetainFailure {
    pub fn into_parts(self: Box<Self>) -> (Box<LaunchStorage>, ObservedCreatePlan, LaptopError) {
        (self.storage, self.plan, self.cause)
    }
    pub fn cause(&self) -> &LaptopError {
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
