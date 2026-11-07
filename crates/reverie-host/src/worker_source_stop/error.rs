use super::*;
#[derive(Debug)]
pub enum SourceStopError {
    NativeData(reverie_contracts::reservation_engine::EngineDataError),
    Data(SourceStopDataError),
    Engine(crate::engine_metadata::EngineError),
    Kernel(crate::reservation_kernel::ReservationKernelError),
    Resource(crate::worker_storage::StorageOwnerError),
    Observation(crate::worker_launch::ExistingObservationError),
    Refused(&'static str),
    Recorded(Arc<Self>),
}
impl SourceStopError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::NativeData(error) => error.code(),
            Self::Data(error) => error.code(),
            Self::Engine(error) => error.code(),
            Self::Kernel(error) => error.code(),
            Self::Resource(error) => error.code(),
            Self::Observation(_) => "WORKER_ORDINARY_STOP_OBSERVATION",
            Self::Refused(code) => code,
            Self::Recorded(error) => error.code(),
        }
    }
}
impl std::fmt::Display for SourceStopError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NativeData(error) => error.fmt(out),
            Self::Data(error) => error.fmt(out),
            Self::Engine(error) => error.fmt(out),
            Self::Kernel(error) => error.fmt(out),
            Self::Resource(error) => error.fmt(out),
            Self::Observation(error) => error.fmt(out),
            Self::Refused(code) => out.write_str(code),
            Self::Recorded(error) => error.fmt(out),
        }
    }
}
impl std::error::Error for SourceStopError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::NativeData(error) => Some(error),
            Self::Data(error) => Some(error),
            Self::Engine(error) => Some(error),
            Self::Kernel(error) => Some(error),
            Self::Resource(error) => Some(error),
            Self::Observation(error) => Some(error),
            Self::Recorded(error) => Some(error.as_ref()),
            Self::Refused(_) => None,
        }
    }
}
pub(super) type Result<T> = std::result::Result<T, SourceStopError>;
pub(super) fn need(value: bool, code: &'static str) -> Result<()> {
    if value {
        Ok(())
    } else {
        Err(SourceStopError::Refused(code))
    }
}
