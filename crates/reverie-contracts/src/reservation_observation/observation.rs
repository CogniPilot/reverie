use super::*;
use reverie_core::{
    operations::{self, JournalDigest, JournalId, MemoryBytes},
    revision::{Generation, ProfileVersion},
};
#[derive(Debug)]
pub struct ReservationObservationFields {
    pub pool: JournalId,
    pub pool_revision: JournalDigest,
    pub budget_bytes: u64,
    pub committed_bytes: u64,
    pub employee: ProfileEmployeeId,
    pub current_session: ProfileSessionId,
    pub generation: Generation,
    pub source_binding: JournalDigest,
    pub profile_version: ProfileVersion,
    pub current_memory: MemoryBytes,
}
/// Read-side legacy observation DATA. Profile IDs may be nil; journal role
/// conversion is separately checked only when this enters an actual claim.
#[derive(Debug)]
pub struct ReservationObservation(ReservationObservationFields);
impl ReservationObservation {
    pub fn try_new(fields: ReservationObservationFields) -> operations::Result<Self> {
        operations::validate_observation_capacity(
            fields.budget_bytes,
            fields.committed_bytes,
            fields.current_memory,
        )?;
        Ok(Self(fields))
    }
    pub fn fields(&self) -> &ReservationObservationFields {
        &self.0
    }
    pub fn canonical_bytes(&self) -> Vec<u8> {
        crate::worker_config::compact_data(&self.value())
    }
    pub fn digest(&self) -> JournalDigest {
        super::digests::digest(&self.value())
            .expect("checked observation contains only finite ASCII fields")
    }
    pub fn journal_data(&self) -> operations::Result<operations::CapacityObservation> {
        crate::operations_v1::decode_observation(&self.canonical_bytes())
    }
    /// Existing recovery compares the entire observation dictionary. A fresh
    /// nil profile SID can be changed DATA without becoming a valid journal ID.
    pub fn matches_journal(&self, stored: &operations::CapacityObservation) -> bool {
        self.value()
            .python_eq(&crate::operations_v1::observation(stored))
    }
    fn value(&self) -> Value {
        let fields = &self.0;
        let entries = [
            ("pool_id", fields.pool.as_str().to_owned()),
            (
                "pool_revision_digest",
                fields.pool_revision.as_str().to_owned(),
            ),
            ("budget_bytes", fields.budget_bytes.to_string()),
            ("committed_bytes", fields.committed_bytes.to_string()),
            ("employee_id", fields.employee.as_str().to_owned()),
            ("current_sid", fields.current_session.as_str().to_owned()),
            ("generation", fields.generation.get().to_string()),
            (
                "source_binding_digest",
                fields.source_binding.as_str().to_owned(),
            ),
            ("profile_version", fields.profile_version.get().to_string()),
            (
                "current_memory_bytes",
                fields.current_memory.get().to_string(),
            ),
        ];
        Value(Node::Object(
            entries
                .into_iter()
                .map(|(name, value)| (key(name), Value(Node::String(key(&value)))))
                .collect(),
        ))
    }
}
