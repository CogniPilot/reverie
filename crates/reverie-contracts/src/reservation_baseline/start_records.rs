//! Original private STARTING receipt DATA, never a process-local claim owner.
use super::*;
use crate::{
    storage_identity::Metadata,
    worker_config::{self, EffectiveWorkerConfig},
};
use reverie_core::{
    operations::{JournalDigest, JournalId, Operation, OperationState},
    profiles::ResourceProfile,
};
type Checked<T> = std::result::Result<T, StartDataError>;
fn digest(value: &Value) -> Checked<JournalDigest> {
    let raw =
        crate::reservation_control::fingerprint(value).map_err(|_| StartDataError::Fingerprint)?;
    Ok(JournalDigest::parse(&crate::digest::hex(&raw)).expect("SHA256"))
}
fn string(value: &str) -> Value {
    Value(Node::String(key(value)))
}
fn require(value: bool, error: StartDataError) -> Checked<()> {
    if value { Ok(()) } else { Err(error) }
}
fn field_required<'a>(fields: &'a Object, name: &str) -> Checked<&'a Value> {
    field(fields, name).ok_or(StartDataError::Structure)
}
fn exact_text(fields: &Object, name: &str, value: &str) -> Checked<bool> {
    Ok(matches!(&field_required(fields,name)?.0,Node::String(actual) if actual.equals_ascii(value)))
}
pub struct StartIntentRecord {
    operation: JournalId,
    bytes: Vec<u8>,
}
impl StartIntentRecord {
    pub fn from_observed_data(
        operation: &Operation,
        baseline: &OriginalSourceBaseline,
    ) -> Checked<Self> {
        let operation = operation.data();
        require(
            operation.state == OperationState::Starting && operation.version.get() == 4,
            StartDataError::Permit,
        )?;
        let value = Value(Node::Object(
            [
                (key("schema"), string("reverie-resource-start-intent-v1")),
                (key("operationId"), string(operation.id.as_str())),
                (
                    key("reservationId"),
                    string(operation.reservation_id.as_str()),
                ),
                (key("targetSid"), string(operation.reserved_sid.as_str())),
                (
                    key("nativeBaselineDigest"),
                    string(digest(baseline.data())?.as_str()),
                ),
                (key("state"), string("STARTING")),
            ]
            .into_iter()
            .collect(),
        ));
        Ok(Self {
            operation: operation.id.clone(),
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
pub fn assert_prepared_for_start(
    metadata: &Metadata,
    operation: &Operation,
    profile: &ResourceProfile,
    candidate: &EffectiveWorkerConfig,
    expected: &JournalDigest,
) -> Checked<()> {
    let value = metadata.as_value();
    require(digest(value)? == *expected, StartDataError::Preparation)?;
    let fields = object(value).map_err(|_| StartDataError::Structure)?;
    let op = operation.data();
    let profile = crate::profiles_v1::data(profile).map_err(|_| StartDataError::Fingerprint)?;
    require(
        exact_text(fields, "operationId", op.id.as_str())?
            && exact_text(fields, "reservationId", op.reservation_id.as_str())?
            && exact_text(fields, "profileDigest", digest(&profile)?.as_str())?
            && exact_text(
                fields,
                "afterConfigDigest",
                digest(candidate.as_value())?.as_str(),
            )?,
        StartDataError::Preparation,
    )
}
