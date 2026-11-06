use crate::{
    engine_metadata::EngineError, office::OfficeError, worker_launch::CreateObservationError,
};
use reverie_contracts::worker_launch::NetworkDataError;
#[derive(Debug)]
pub enum LaptopError {
    Refused(&'static str),
    Plan(CreateObservationError),
    Office(OfficeError),
    Network(NetworkDataError),
    Engine(EngineError),
    Nix(crate::worker_nix::NixError),
    Finalization {
        primary: Box<Self>,
        secondary: Box<Self>,
    },
}
impl std::fmt::Display for LaptopError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}
impl LaptopError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Refused(code) => code,
            Self::Plan(_) => "WORKER_LAPTOP_PLAN",
            Self::Office(_) => "WORKER_LAPTOP_OFFICE",
            Self::Network(_) => "WORKER_LAPTOP_NETWORK",
            Self::Engine(error) => error.code(),
            Self::Nix(_) => "WORKER_LAPTOP_NIX",
            Self::Finalization { primary, .. } => primary.code(),
        }
    }
}
impl std::error::Error for LaptopError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Refused(_) => None,
            Self::Plan(error) => Some(error),
            Self::Office(error) => Some(error),
            Self::Network(error) => Some(error),
            Self::Engine(error) => Some(error),
            Self::Nix(error) => Some(error),
            Self::Finalization { primary, .. } => Some(primary.as_ref()),
        }
    }
}
pub(super) type Result<T> = std::result::Result<T, LaptopError>;
pub(super) fn need(value: bool, code: &'static str) -> Result<()> {
    if value {
        Ok(())
    } else {
        Err(LaptopError::Refused(code))
    }
}
pub(super) fn finalized<T>(result: Result<T>, secondary: Result<()>) -> Result<T> {
    match (result, secondary) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(primary), Err(secondary)) => Err(LaptopError::Finalization {
            primary: Box::new(primary),
            secondary: Box::new(secondary),
        }),
    }
}
