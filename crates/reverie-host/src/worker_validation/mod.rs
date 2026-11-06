//! Readonly optional-policy and owner-loader observations. The application owns
//! full validation order; these values never grant mount/start or owner power.
mod ops;
use crate::{ObservationError, native};
use reverie_contracts::{
    worker_config::EffectiveWorkerConfig,
    worker_validation::{PrivateSelector, WorkerValidationData, WorkerValidationError},
};
use reverie_core::posix_path::PosixPath;
use std::{collections::BTreeSet, fmt};

#[derive(Debug)]
pub enum WorkerValidationHostError {
    Loader(reverie_contracts::worker_config::WorkerConfigError),
    Data(WorkerValidationError),
    Observation(ObservationError),
    Selector,
    Cold,
    Ops,
}
impl WorkerValidationHostError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Loader(error) => error.code(),
            Self::Data(_) => "WORKER_VALIDATION_DATA",
            Self::Observation(error) => error.code(),
            Self::Selector => "WORKER_PRIVATE_SELECTOR_PATH",
            Self::Cold => "WORKER_COLD_POLICY",
            Self::Ops => "WORKER_OPS_BINDING",
        }
    }
}
impl fmt::Display for WorkerValidationHostError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for WorkerValidationHostError {}
impl From<WorkerValidationError> for WorkerValidationHostError {
    fn from(value: WorkerValidationError) -> Self {
        Self::Data(value)
    }
}
impl From<ObservationError> for WorkerValidationHostError {
    fn from(value: ObservationError) -> Self {
        Self::Observation(value)
    }
}
impl From<std::io::Error> for WorkerValidationHostError {
    fn from(value: std::io::Error) -> Self {
        Self::Observation(value.into())
    }
}
type Result<T> = std::result::Result<T, WorkerValidationHostError>;

/// Actual owner-only regular-file capture; no full worker validation, host
/// startup, migration or authority is implied by successful decoding.
pub fn load_owner_configuration(path: &std::path::Path) -> Result<EffectiveWorkerConfig> {
    let raw = native::read_worker_config(path)?;
    reverie_contracts::worker_config::decode_owner_text(&raw)
        .map_err(WorkerValidationHostError::Loader)
}

pub fn observe_ops_binding(config: &EffectiveWorkerConfig) -> Result<()> {
    let data = WorkerValidationData::new(config);
    if let Some(path) = data.ops_path()? {
        ops::validate(&data, &path)?;
    }
    Ok(())
}
pub fn observe_private_selector(
    config: &EffectiveWorkerConfig,
    selected: PrivateSelector,
) -> Result<()> {
    let data = WorkerValidationData::new(config);
    if let Some(value) = data.selector(selected)? {
        let lexical = path(value.codepoints())?;
        if native::resolve_optional_text(value.codepoints())? != lexical {
            return Err(WorkerValidationHostError::Selector);
        }
    }
    Ok(())
}
fn path(points: &[u32]) -> Result<PosixPath> {
    PosixPath::try_new(points).map_err(|_| WorkerValidationHostError::Selector)
}
pub fn observe_cold_policy(config: &EffectiveWorkerConfig) -> Result<()> {
    let data = WorkerValidationData::new(config);
    let Some(policy) = data.cold()? else {
        return Ok(());
    };
    let mut seen = BTreeSet::new();
    for index in 0..policy.len() {
        let value = policy.directory(index)?;
        let candidate = path(value.codepoints())?;
        if native::resolve_optional_text(value.codepoints())? != candidate {
            return Err(WorkerValidationHostError::Cold);
        }
        // Resolve all sources afresh for EACH candidate as the original policy
        // does, after the earlier strict mount/attachment stage has completed.
        let (lexical, mounts) = policy.protected_roots()?;
        let mut protected = lexical
            .iter()
            .map(|value| path(value.codepoints()))
            .collect::<Result<Vec<_>>>()?;
        for value in mounts {
            protected.push(native::resolve_optional_text(value.codepoints())?);
        }
        if protected.iter().any(|base| candidate.overlaps(base))
            || !seen.insert(value.codepoints().to_vec())
        {
            return Err(WorkerValidationHostError::Cold);
        }
    }
    Ok(())
}
