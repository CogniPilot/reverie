//! The installing broker's real current/detached intent observation. Company
//! text intentionally follows aliases and has no invented metadata custody or
//! byte cap; only the fallback uses worker_storage's strict metadata policy.
use crate::{ObservationError, native, observation::finalized};
use reverie_contracts::{
    worker_config::EffectiveWorkerConfig,
    worker_intent::{self, IntentDataError, WorkerIntentConfiguration},
};
use reverie_core::{ids::ProfileSessionId, posix_path::PosixPath};
use reverie_store::storage_identity::{self, IdentityError};
use std::{
    fmt,
    fs::File,
    io::{self, Read},
    path::PathBuf,
};

#[derive(Debug)]
pub enum IntentHostError {
    Data(IntentDataError),
    Company(ObservationError),
    Plan(IdentityError),
}
impl IntentHostError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Data(error) => error.code(),
            Self::Company(_) => "WORKER_COMPANY_UNAVAILABLE",
            Self::Plan(_) => "WORKER_PLAN_UNAVAILABLE",
        }
    }
}
impl fmt::Display for IntentHostError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for IntentHostError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Data(error) => Some(error),
            Self::Company(error) => Some(error),
            Self::Plan(error) => Some(error),
        }
    }
}
impl From<IntentDataError> for IntentHostError {
    fn from(value: IntentDataError) -> Self {
        Self::Data(value)
    }
}
type Result<T> = std::result::Result<T, IntentHostError>;
fn company_path(config: &WorkerIntentConfiguration<'_>) -> Result<PathBuf> {
    let points = config.company_file()?;
    let normalized = PosixPath::try_new(points.codepoints()).map_err(|_| {
        IntentHostError::Company(io::Error::from(io::ErrorKind::InvalidInput).into())
    })?;
    native::python_path(&normalized.codepoints())
        .map_err(|error| IntentHostError::Company(error.into()))
}
fn company_text(path: &std::path::Path) -> std::result::Result<Vec<u8>, ObservationError> {
    let mut file = File::open(path)?;
    let mut bytes = Vec::new();
    let read = file
        .read_to_end(&mut bytes)
        .map(|_| bytes)
        .map_err(Into::into);
    finalized(read, native::close(file))
}
/// Current intent DATA, not authorization or a start grant. The actual service
/// owner selects the captured configuration and canonical session; wire input
/// cannot select a company/journal path or replace this observation with bools.
pub fn read_allowed(config: &EffectiveWorkerConfig, session: &ProfileSessionId) -> Result<bool> {
    let settings = WorkerIntentConfiguration::new(config);
    let company = company_path(&settings)?;
    let raw = company_text(&company).map_err(IntentHostError::Company)?;
    if let Some(allowed) = worker_intent::current_allowed(&raw, session)? {
        return Ok(allowed);
    }
    // Keep UID lookup AFTER current employee selection. No second registry or
    // storage resolver may introduce generation/owner/desired-state gates.
    let uid = settings.uid()?;
    let journal = company.with_file_name("plan-moves.json");
    match storage_identity::read_metadata(&journal, uid, 1024 * 1024) {
        Ok(metadata) => worker_intent::detached_allowed(&metadata, session).map_err(Into::into),
        Err(IdentityError::Io(error)) if error.kind() == io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(IntentHostError::Plan(error)),
    }
}

/// Viewer-only selection requires an actual current company member. Unlike
/// ordinary detached recovery, an absent SID never falls through to allowance.
pub fn read_current_viewer_binding(
    config: &EffectiveWorkerConfig,
    session: &ProfileSessionId,
) -> Result<Option<reverie_contracts::storage_identity::CurrentEmployee>> {
    let company = company_path(&WorkerIntentConfiguration::new(config))?;
    let raw = company_text(&company).map_err(IntentHostError::Company)?;
    if worker_intent::current_allowed(&raw, session)? != Some(true) {
        return Ok(None);
    }
    let metadata = reverie_contracts::storage_identity::decode_metadata(&raw)
        .map_err(|cause| IntentHostError::Plan(IdentityError::Data(cause)))?;
    let records = metadata
        .company_records()
        .map_err(|cause| IntentHostError::Plan(IdentityError::Data(cause)))?;
    let Some(employee) = records.by_session(session) else {
        return Ok(None);
    };
    let identity = employee
        .canonical_identity()
        .map_err(|cause| IntentHostError::Plan(IdentityError::Data(cause)))?;
    metadata
        .current_employee(&identity, session, employee.owner())
        .map_err(|cause| IntentHostError::Plan(IdentityError::Data(cause)))
}

#[cfg(test)]
mod tests;
