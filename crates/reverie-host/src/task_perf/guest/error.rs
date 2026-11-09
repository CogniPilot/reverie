use crate::{ObservationError, engine_metadata::EngineError};
use reverie_contracts::task_perf_check::PerfCheckDataError;
use std::{fmt, io};

#[derive(Debug)]
pub enum PerfCheckError {
    Refused(&'static str),
    Io(io::Error),
    Observation(ObservationError),
    Capture(EngineError),
    Data(PerfCheckDataError),
    Child {
        code: u8,
    },
    Signal {
        cause: io::Error,
        restoration_failed: bool,
    },
    Finalization {
        primary: Box<Self>,
        secondary: Box<Self>,
    },
}
impl fmt::Display for PerfCheckError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "TASK_PERF_CHECK: {self:?}")
    }
}
impl std::error::Error for PerfCheckError {}
impl From<io::Error> for PerfCheckError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}
impl From<ObservationError> for PerfCheckError {
    fn from(error: ObservationError) -> Self {
        Self::Observation(error)
    }
}
impl From<PerfCheckDataError> for PerfCheckError {
    fn from(error: PerfCheckDataError) -> Self {
        Self::Data(error)
    }
}
impl From<crate::captured_client::Error> for PerfCheckError {
    fn from(error: crate::captured_client::Error) -> Self {
        Self::Capture(error.into())
    }
}
pub(super) type Result<T> = std::result::Result<T, PerfCheckError>;
pub(super) fn need(value: bool, code: &'static str) -> Result<()> {
    if value {
        Ok(())
    } else {
        Err(PerfCheckError::Refused(code))
    }
}
pub(super) fn finalized<T>(primary: Result<T>, closed: Result<()>) -> Result<T> {
    match (primary, closed) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(primary), Err(secondary)) => Err(PerfCheckError::Finalization {
            primary: Box::new(primary),
            secondary: Box::new(secondary),
        }),
    }
}
impl PerfCheckError {
    pub(super) fn close_unknown(&self) -> bool {
        match self {
            Self::Observation(error) => error.has_unconfirmed_close(),
            Self::Signal {
                restoration_failed, ..
            } => *restoration_failed,
            Self::Finalization { primary, secondary } => {
                primary.close_unknown() || secondary.close_unknown()
            }
            _ => false,
        }
    }
}
