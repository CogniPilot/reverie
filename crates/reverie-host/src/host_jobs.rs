//! Readonly fixed-host-scope path declarations. This resolves source path DATA
//! only; it neither qualifies code hashes nor owns a unit/process/settlement.
use crate::{ObservationError, native};
use reverie_contracts::host_jobs::{HostJobDataError, HostJobPath, HostJobSpecData};
use reverie_core::posix_path::PosixPath;
use std::fmt;
#[derive(Debug)]
pub enum HostJobPathError {
    Data(HostJobDataError),
    Observation(ObservationError),
    Canonical,
}
impl HostJobPathError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Data(error) => error.code(),
            Self::Observation(error) => error.code(),
            Self::Canonical => "CANONICAL_SCOPE_PATH",
        }
    }
}
impl fmt::Display for HostJobPathError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for HostJobPathError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Data(error) => Some(error),
            Self::Observation(error) => Some(error),
            Self::Canonical => None,
        }
    }
}
/// Original FixedHostJobSpec.validate path phase, in exact source order.
/// Missing tails remain nonstrict path data, not artifact custody/readiness.
pub fn qualify_path_declarations(spec: &HostJobSpecData) -> Result<(), HostJobPathError> {
    for selected in HostJobPath::ORDER {
        let text = spec.path(selected).map_err(HostJobPathError::Data)?;
        let path =
            PosixPath::try_new(text.codepoints()).map_err(|_| HostJobPathError::Canonical)?;
        if !path.is_absolute() || path.has_parent_component() {
            return Err(HostJobPathError::Canonical);
        }
        let observed = native::resolve_optional_text(&path.codepoints())
            .map_err(|error| HostJobPathError::Observation(error.into()))?;
        if observed != path {
            return Err(HostJobPathError::Canonical);
        }
    }
    Ok(())
}
