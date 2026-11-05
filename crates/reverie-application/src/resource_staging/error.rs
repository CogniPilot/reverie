use reverie_contracts::{broker_resources::ResourceConfigError, profiles_v1::CodecError};
use reverie_host::{
    device_policy::DevicePolicyHostError, lease_policy::LeaseHostError,
    task_perf::TaskPerfHostError,
};
use reverie_store::{StoreError, storage_identity::IdentityError};
use std::fmt;

#[derive(Debug)]
pub enum ResourceServiceError {
    Resources(ResourceConfigError),
    Profile(CodecError),
    Store(StoreError),
    Identity(IdentityError),
    Device(DevicePolicyHostError),
    Perf(TaskPerfHostError),
    Lease(LeaseHostError),
    Finalization {
        primary: Box<Self>,
        finalizer: StoreError,
    },
}
impl ResourceServiceError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Resources(error) => error.code(),
            Self::Profile(error) => error.code(),
            Self::Store(error) => error.code(),
            Self::Identity(error) => error.code(),
            Self::Device(error) => error.code(),
            Self::Perf(error) => error.code(),
            Self::Lease(error) => error.code(),
            Self::Finalization { .. } => "RESOURCE_STAGE_FINALIZATION",
        }
    }
}
impl fmt::Display for ResourceServiceError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for ResourceServiceError {}
impl From<ResourceConfigError> for ResourceServiceError {
    fn from(value: ResourceConfigError) -> Self {
        Self::Resources(value)
    }
}
impl From<CodecError> for ResourceServiceError {
    fn from(value: CodecError) -> Self {
        Self::Profile(value)
    }
}
impl From<StoreError> for ResourceServiceError {
    fn from(value: StoreError) -> Self {
        Self::Store(value)
    }
}
impl From<IdentityError> for ResourceServiceError {
    fn from(value: IdentityError) -> Self {
        Self::Identity(value)
    }
}
impl From<DevicePolicyHostError> for ResourceServiceError {
    fn from(value: DevicePolicyHostError) -> Self {
        Self::Device(value)
    }
}
impl From<TaskPerfHostError> for ResourceServiceError {
    fn from(value: TaskPerfHostError) -> Self {
        Self::Perf(value)
    }
}
impl From<LeaseHostError> for ResourceServiceError {
    fn from(value: LeaseHostError) -> Self {
        Self::Lease(value)
    }
}
pub(super) type Result<T> = std::result::Result<T, ResourceServiceError>;
pub(super) fn finalized<T>(
    value: Result<T>,
    finish: std::result::Result<(), StoreError>,
) -> Result<T> {
    match (value, finish) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) => Err(error),
        (Ok(_), Err(error)) => Err(error.into()),
        (Err(primary), Err(finalizer)) => Err(ResourceServiceError::Finalization {
            primary: Box::new(primary),
            finalizer,
        }),
    }
}
