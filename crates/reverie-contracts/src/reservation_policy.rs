//! Fixed resource-preparation policy records and candidate bytes. These are
//! finite DATA, never permission to replace a file, reload or start. Native
//! original/readback bounds belong at their source phases, not this encoder.
use crate::{
    legacy_json::{Node, Text, Value},
    worker_config::{self, EffectiveWorkerConfig},
};
use reverie_core::{
    operations::{JournalDigest, JournalId, Operation},
    profiles::ResourceProfile,
};
use std::fmt;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PolicyDataError {
    Fingerprint,
}
impl PolicyDataError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Fingerprint => "RESOURCE_PREPARATION_CONFIG_FINGERPRINT",
        }
    }
}
impl fmt::Display for PolicyDataError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}
impl std::error::Error for PolicyDataError {}
/// Only the actual policy-current read_metadata result, for the application's
/// complete worker validator. Copy lossless data directly; do not stringify
/// surrogate codepoints or claim parsing supplies validation/custody.
pub fn configuration_for_validation(
    metadata: &crate::storage_identity::Metadata,
) -> Result<EffectiveWorkerConfig, crate::worker_config::WorkerConfigError> {
    let mut value = metadata.as_value().deep_clone();
    let Node::Object(fields) = std::mem::replace(&mut value.0, Node::Null) else {
        return Err(crate::worker_config::WorkerConfigError::ExpectedObject);
    };
    Ok(EffectiveWorkerConfig::from_object(fields))
}
fn key(value: &str) -> Text {
    Text(value.chars().map(u32::from).collect())
}
fn string(value: &str) -> Value {
    Value(Node::String(key(value)))
}
fn digest(value: &Value) -> Result<JournalDigest, PolicyDataError> {
    let digest =
        crate::reservation_control::fingerprint(value).map_err(|_| PolicyDataError::Fingerprint)?;
    Ok(JournalDigest::parse(&crate::digest::hex(&digest)).expect("SHA256"))
}
/// Exact legacy J.encode(candidate), distinct from spaced worker hash bytes.
pub struct PolicyCandidateData {
    bytes: Vec<u8>,
    digest: JournalDigest,
}
impl PolicyCandidateData {
    pub fn capture(config: &EffectiveWorkerConfig) -> Result<Self, PolicyDataError> {
        let digest = digest(config.as_value())?;
        let bytes = worker_config::compact_data(config.as_value());
        Ok(Self { bytes, digest })
    }
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
    pub fn digest(&self) -> &JournalDigest {
        &self.digest
    }
}
pub struct PolicyAttemptRecord {
    operation: JournalId,
    bytes: Vec<u8>,
}
impl PolicyAttemptRecord {
    pub fn from_observed_data(
        operation: &JournalId,
        before: &EffectiveWorkerConfig,
        after: &PolicyCandidateData,
    ) -> Result<Self, PolicyDataError> {
        let value = Value(Node::Object(
            [
                (key("schema"), string("reverie-resource-config-attempt-v1")),
                (key("operationId"), string(operation.as_str())),
                (
                    key("beforeDigest"),
                    string(digest(before.as_value())?.as_str()),
                ),
                (key("afterDigest"), string(after.digest().as_str())),
            ]
            .into_iter()
            .collect(),
        ));
        Ok(Self {
            operation: operation.clone(),
            bytes: worker_config::compact_data(&value),
        })
    }
    pub fn operation_id(&self) -> &JournalId {
        &self.operation
    }
    pub fn canonical_bytes(&self) -> &[u8] {
        &self.bytes
    }
}
pub struct PreparedPolicyFields<'a> {
    pub operation: &'a Operation,
    pub profile: &'a ResourceProfile,
    pub before: &'a EffectiveWorkerConfig,
    pub after: &'a PolicyCandidateData,
    pub source_binding: &'a JournalDigest,
}
/// Closed native-preparation receipt DATA. A real journal acknowledgement also
/// requires the application's live held handle and adjacent policy fence.
pub struct PreparedPolicyRecord {
    operation: JournalId,
    bytes: Vec<u8>,
    digest: JournalDigest,
}
impl PreparedPolicyRecord {
    pub fn from_observed_data(fields: PreparedPolicyFields<'_>) -> Result<Self, PolicyDataError> {
        let operation = fields.operation.data();
        let profile =
            crate::profiles_v1::data(fields.profile).map_err(|_| PolicyDataError::Fingerprint)?;
        let value = Value(Node::Object(
            [
                (
                    key("schema"),
                    string("reverie-resource-native-preparation-v1"),
                ),
                (key("operationId"), string(operation.id.as_str())),
                (
                    key("reservationId"),
                    string(operation.reservation_id.as_str()),
                ),
                (
                    key("profileVersion"),
                    Value(Node::Number(crate::legacy_json::Number::Integer(
                        fields.profile.version().get().to_string(),
                    ))),
                ),
                (key("profileDigest"), string(digest(&profile)?.as_str())),
                (
                    key("beforeConfigDigest"),
                    string(digest(fields.before.as_value())?.as_str()),
                ),
                (
                    key("afterConfigDigest"),
                    string(fields.after.digest().as_str()),
                ),
                (
                    key("sourceBindingDigest"),
                    string(fields.source_binding.as_str()),
                ),
                (
                    key("state"),
                    string("PREPARED_CONFIG_ONLY_SOURCE_UNCHANGED"),
                ),
            ]
            .into_iter()
            .collect(),
        ));
        Ok(Self {
            operation: operation.id.clone(),
            bytes: worker_config::compact_data(&value),
            digest: digest(&value)?,
        })
    }
    pub fn operation_id(&self) -> &JournalId {
        &self.operation
    }
    pub fn canonical_bytes(&self) -> &[u8] {
        &self.bytes
    }
    pub fn digest(&self) -> &JournalDigest {
        &self.digest
    }
}
