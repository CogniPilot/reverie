use crate::resource_staging::ResourceServiceError;
use reverie_contracts::reservation_engine::EngineDataError;
use reverie_core::capacity::CapacityError;
use reverie_host::{engine_metadata::EngineError, reservation_kernel::ReservationKernelError};
use std::fmt;
#[derive(Debug)]
pub enum ObserverError {
    Engine(EngineError),
    Kernel(ReservationKernelError),
    Data(EngineDataError),
    Effective(ResourceServiceError),
    Capacity(CapacityError),
    Refused(&'static str),
}
impl ObserverError {
    pub(crate) fn has_unconfirmed_close(&self) -> bool {
        matches!(self, Self::Kernel(error) if error.has_unconfirmed_close())
    }
    pub fn code(&self) -> &'static str {
        match self {
            Self::Engine(error) => error.code(),
            Self::Kernel(error) => error.code(),
            Self::Data(error) => error.code(),
            Self::Effective(error) => error.code(),
            Self::Capacity(error) => error.code(),
            Self::Refused(code) => code,
        }
    }
}
impl fmt::Display for ObserverError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for ObserverError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Engine(error) => Some(error),
            Self::Kernel(error) => Some(error),
            Self::Data(error) => Some(error),
            Self::Effective(error) => Some(error),
            Self::Capacity(error) => Some(error),
            Self::Refused(_) => None,
        }
    }
}
impl From<EngineError> for ObserverError {
    fn from(value: EngineError) -> Self {
        Self::Engine(value)
    }
}
impl From<ReservationKernelError> for ObserverError {
    fn from(value: ReservationKernelError) -> Self {
        Self::Kernel(value)
    }
}
impl From<EngineDataError> for ObserverError {
    fn from(value: EngineDataError) -> Self {
        Self::Data(value)
    }
}
impl From<ResourceServiceError> for ObserverError {
    fn from(value: ResourceServiceError) -> Self {
        Self::Effective(value)
    }
}
impl From<CapacityError> for ObserverError {
    fn from(value: CapacityError) -> Self {
        Self::Capacity(value)
    }
}
pub(super) type Result<T> = std::result::Result<T, ObserverError>;
pub(super) fn need(value: bool, code: &'static str) -> Result<()> {
    if value {
        Ok(())
    } else {
        Err(ObserverError::Refused(code))
    }
}
