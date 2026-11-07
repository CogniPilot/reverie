use super::*;
#[derive(Debug)]
pub(super) enum PreparationError {
    Gate(GateError),
    Transport(WorkerReportError),
    Storage(StorageWorkflowError),
    Observation(OwnedCreatePreparationError),
    Validation(crate::worker_validation::WorkerValidationError),
    Refused(&'static str),
}
impl std::fmt::Display for PreparationError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Gate(e) => e.fmt(out),
            Self::Transport(e) => e.fmt(out),
            Self::Storage(e) => e.fmt(out),
            Self::Observation(e) => e.fmt(out),
            Self::Validation(e) => e.fmt(out),
            Self::Refused(code) => out.write_str(code),
        }
    }
}
impl std::error::Error for PreparationError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Gate(e) => Some(e),
            Self::Transport(e) => Some(e),
            Self::Storage(e) => Some(e),
            Self::Observation(e) => Some(e),
            Self::Validation(e) => Some(e),
            Self::Refused(_) => None,
        }
    }
}
macro_rules! from {
    ($ty:ty, $case:ident) => {
        impl From<$ty> for PreparationError {
            fn from(error: $ty) -> Self {
                Self::$case(error)
            }
        }
    };
}
from!(GateError, Gate);
from!(WorkerReportError, Transport);
from!(StorageWorkflowError, Storage);
from!(OwnedCreatePreparationError, Observation);
from!(crate::worker_validation::WorkerValidationError, Validation);
