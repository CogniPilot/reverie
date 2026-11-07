use super::{MIB, Result, need};
use crate::{
    ids::NativeOperationId,
    revision::{Generation, ObservedProfileVersion},
};

/// Canonical nonnil UUID reference used in the existing journal's closed roles.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct JournalId(NativeOperationId);
impl JournalId {
    pub fn parse(value: &str) -> Result<Self> {
        Ok(Self(
            NativeOperationId::parse(value).map_err(|_| super::OperationError::new("UUID"))?,
        ))
    }
    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }
}
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct JournalDigest(String);
impl JournalDigest {
    pub fn parse(value: &str) -> Result<Self> {
        need(
            value.len() == 64
                && value
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "DIGEST",
        )?;
        Ok(Self(value.into()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct MemoryBytes(u64);
impl MemoryBytes {
    pub fn try_new(value: u64) -> Result<Self> {
        need(value > 0, "POSITIVE_MEMORY")?;
        need(
            value.is_multiple_of(MIB) && value / MIB <= crate::revision::JS_SAFE_MAX,
            "REPRESENTABLE_MEMORY",
        )?;
        Ok(Self(value))
    }
    pub fn get(self) -> u64 {
        self.0
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecoveryReason(String);
impl RecoveryReason {
    pub fn parse(value: &str) -> Result<Self> {
        need(
            !value.is_empty()
                && value.len() <= 80
                && value.as_bytes()[0].is_ascii_uppercase()
                && value
                    .bytes()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_'),
            "REASON",
        )?;
        Ok(Self(value.into()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct OperationScope {
    pub owner_scope_digest: JournalDigest,
    pub company_id: JournalId,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperationRequest {
    pub employee_id: JournalId,
    pub pool_id: JournalId,
    pub source_binding_digest: JournalDigest,
    pub profile_version: ObservedProfileVersion,
    pub requested_memory_bytes: MemoryBytes,
    pub preview_digest: JournalDigest,
    pub observation_digest: JournalDigest,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ObservationData {
    pub pool_id: JournalId,
    pub pool_revision_digest: JournalDigest,
    pub budget_bytes: u64,
    pub committed_bytes: u64,
    pub employee_id: JournalId,
    pub current_sid: JournalId,
    pub generation: Generation,
    pub source_binding_digest: JournalDigest,
    pub profile_version: ObservedProfileVersion,
    pub current_memory_bytes: MemoryBytes,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CapacityObservation(ObservationData);
impl CapacityObservation {
    pub fn try_new(data: ObservationData) -> Result<Self> {
        validate_observation_capacity(
            data.budget_bytes,
            data.committed_bytes,
            data.current_memory_bytes,
        )?;
        Ok(Self(data))
    }
    pub fn data(&self) -> &ObservationData {
        &self.0
    }
}
pub fn validate_observation_capacity(
    budget: u64,
    committed: u64,
    allocated: MemoryBytes,
) -> Result<()> {
    need(budget > 0, "POSITIVE_MEMORY")?;
    validate_allocated_commitment(allocated, committed)?;
    need(committed <= budget, "POOL_CAPACITY")
}
pub fn validate_allocated_commitment(allocated: MemoryBytes, committed: u64) -> Result<()> {
    need(allocated.get() <= committed, "POOL_CAPACITY")
}
