//! Closed cold TMP data views. They confer no storage/native/launch authority.
mod census;
mod lease;
mod numbers;
mod records;
mod reference_data;
mod reference_report;
mod reference_rows;
mod retirement;
use crate::{
    legacy_json::{Node, Text, Value},
    storage_identity::MetadataText,
    worker_config::{self, EffectiveWorkerConfig},
    worker_validation::WorkerValidationData,
};
pub use census::{ColdBind, ColdContainer, ColdContainerState, ColdInventory, ColdInventoryIds};
pub use lease::{
    ClearReservation, ColdLeaseState, clear_holder_metadata, clear_path_metadata,
    clear_reservation, retained_record_path, retained_reservation,
};
pub use records::{clear_complete_record, clear_pending_record};
pub use reference_data::{ReferenceFdHeader, ReferenceProcessIdentity, reference_credentials};
pub use reference_report::{
    KnownReference, ReferenceKind, ReferenceLink, ReferenceReport, UnknownReference,
};
pub use reference_rows::{ReferenceMapRow, ReferenceUnixRow};
pub use retirement::{RetainedLeaseKind, RetainedLeaseName, RetainedLeaseRecord};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fmt};
type Object = BTreeMap<Text, Value>;
type Result<T> = std::result::Result<T, ColdDataError>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ColdDataError {
    Policy,
    Json,
    Inventory,
    State,
    Mounts,
    Lease,
    Reservation,
    Reference,
}
impl fmt::Display for ColdDataError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(match self {
            Self::Policy => "WORKER_COLD_POLICY",
            Self::Json => "WORKER_COLD_JSON",
            Self::Inventory => "WORKER_COLD_INVENTORY",
            Self::State => "WORKER_COLD_CONTAINER_STATE",
            Self::Mounts => "WORKER_COLD_MOUNTS",
            Self::Lease => "WORKER_COLD_LEASE_METADATA",
            Self::Reservation => "WORKER_COLD_RESERVATION",
            Self::Reference => "WORKER_COLD_REFERENCE_METADATA",
        })
    }
}
impl std::error::Error for ColdDataError {}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ColdStrategy {
    Clear,
    RetainAndReplace,
}

/// Captured original configuration, distinct from effective resource overrides.
/// Native consumers must obtain it through their actual same-owner plan.
pub struct ColdConfiguration {
    source: EffectiveWorkerConfig,
    strategy: ColdStrategy,
    leases: Vec<MetadataText>,
}
impl ColdConfiguration {
    pub fn capture(source: &EffectiveWorkerConfig) -> Result<Option<Self>> {
        let Some(policy) = WorkerValidationData::new(source)
            .cold()
            .map_err(|_| ColdDataError::Policy)?
        else {
            return Ok(None);
        };
        let root = object(source.as_value()).ok_or(ColdDataError::Policy)?;
        let policy_value =
            object(field(root, "coldTemporaryCleanup").ok_or(ColdDataError::Policy)?)
                .ok_or(ColdDataError::Policy)?;
        let strategy = match field(policy_value, "strategy") {
            None => ColdStrategy::Clear,
            Some(Value(Node::String(text))) if text.equals_ascii("clear") => ColdStrategy::Clear,
            Some(Value(Node::String(text))) if text.equals_ascii("retain-and-replace") => {
                ColdStrategy::RetainAndReplace
            }
            _ => return Err(ColdDataError::Policy),
        };
        let leases = (0..policy.len())
            .map(|index| policy.directory(index).map_err(|_| ColdDataError::Policy))
            .collect::<Result<_>>()?;
        Ok(Some(Self {
            source: source.clone(),
            strategy,
            leases,
        }))
    }
    pub fn source(&self) -> &EffectiveWorkerConfig {
        &self.source
    }
    pub fn strategy(&self) -> ColdStrategy {
        self.strategy
    }
    pub fn host_lease_directories(&self) -> &[MetadataText] {
        &self.leases
    }
    /// Exact _digest(config): full sorted compact Python JSON, not policy hash.
    pub fn digest(&self) -> String {
        let hash = Sha256::digest(worker_config::compact_data(self.source.as_value())).into();
        crate::digest::hex(&hash)
    }
    pub fn mounts(&self) -> Result<Vec<ColdDeclaredMount<'_>>> {
        let root = object(self.source.as_value()).ok_or(ColdDataError::Policy)?;
        let Some(Value(Node::Array(rows))) = field(root, "mounts") else {
            return Err(ColdDataError::Policy);
        };
        rows.iter()
            .map(|row| {
                object(row)
                    .map(|data| ColdDeclaredMount { data })
                    .ok_or(ColdDataError::Mounts)
            })
            .collect()
    }
}
pub struct ColdDeclaredMount<'a> {
    data: &'a Object,
}
impl ColdDeclaredMount<'_> {
    pub fn source(&self) -> Result<MetadataText> {
        metadata(field(self.data, "source"), ColdDataError::Mounts)
    }
    pub fn destination(&self) -> Result<MetadataText> {
        metadata(field(self.data, "destination"), ColdDataError::Mounts)
    }
}
fn object(value: &Value) -> Option<&Object> {
    match &value.0 {
        Node::Object(value) => Some(value),
        _ => None,
    }
}
fn key(value: &str) -> Text {
    Text(value.bytes().map(u32::from).collect())
}
fn field<'a>(value: &'a Object, name: &str) -> Option<&'a Value> {
    value.get(&key(name))
}
fn metadata(value: Option<&Value>, error: ColdDataError) -> Result<MetadataText> {
    match value {
        Some(Value(Node::String(value))) => Ok(MetadataText::from_text(value.clone())),
        _ => Err(error),
    }
}
