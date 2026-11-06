//! Read-side lease grant composition and immutable peer artifact observations.
//! No peer/helper invocation, socket service, lease or mounted/kernel proof.
mod artifact;
mod projection;
#[cfg(test)]
mod tests;
pub use artifact::{ArtifactInode, PeerArtifactObservation, observe_peer_artifact};
pub use projection::{LeaseObservation, project_lease};

use crate::ObservationError;
use reverie_contracts::lease_policy::LeaseDataError;
use reverie_core::lease_policy::{LeaseAbsolutePath, LeasePolicyError};
use std::{fmt, io, path::PathBuf};

#[derive(Debug)]
pub enum LeaseHostError {
    Observation(ObservationError),
    Data(LeaseDataError),
    Policy(LeasePolicyError),
    PathEncoding,
    ImmutableNix,
    Machine,
}
impl LeaseHostError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Observation(error) => error.code(),
            Self::Data(error) => error.code(),
            Self::Policy(error) => error.code(),
            Self::PathEncoding => "LEASE_NATIVE_PATH",
            Self::ImmutableNix => "LEASE_IMMUTABLE_NIX_ARTIFACT",
            Self::Machine => "LEASE_NATIVE_MACHINE",
        }
    }
}
impl fmt::Display for LeaseHostError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for LeaseHostError {}
impl From<ObservationError> for LeaseHostError {
    fn from(value: ObservationError) -> Self {
        Self::Observation(value)
    }
}
impl From<LeaseDataError> for LeaseHostError {
    fn from(value: LeaseDataError) -> Self {
        Self::Data(value)
    }
}
impl From<LeasePolicyError> for LeaseHostError {
    fn from(value: LeasePolicyError) -> Self {
        Self::Policy(value)
    }
}
impl From<io::Error> for LeaseHostError {
    fn from(value: io::Error) -> Self {
        Self::Observation(value.into())
    }
}
type Result<T> = std::result::Result<T, LeaseHostError>;

// Python os.fsencode uses surrogateescape for native POSIX paths. Other lone
// surrogates cannot select a native file and must never become replacement text.
fn native_path(value: &LeaseAbsolutePath) -> Result<PathBuf> {
    crate::native::python_path(value.codepoints()).map_err(|_| LeaseHostError::PathEncoding)
}
