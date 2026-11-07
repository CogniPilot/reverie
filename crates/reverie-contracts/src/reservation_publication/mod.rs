//! Exact private publication-intent DATA and fresh-thread recipe projection.
//! Parsing/building this value cannot publish a company row or permit launch.
mod recipe;
use crate::{
    legacy_json::{Node, Text, Value},
    reservation_baseline::OriginalSourceBaseline,
    reservation_observation::ClaimEmployee,
    storage_identity::Metadata,
    worker_config::EffectiveWorkerConfig,
};
use reverie_core::{
    operations::{JournalDigest, Operation},
    profiles::ResourceProfile,
};
use std::{collections::BTreeMap, fmt};
type Object = BTreeMap<Text, Value>;
type Result<T> = std::result::Result<T, PublicationDataError>;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PublicationDataError {
    Recipe,
    Bound,
    Fingerprint,
}
impl PublicationDataError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Recipe => "RESOURCE_PREPARATION_NORMAL_RECIPE_REQUIRED",
            Self::Bound => "RESOURCE_PREPARATION_RECEIPT_BOUND",
            Self::Fingerprint => "RESOURCE_PREPARATION_RECEIPT_FINGERPRINT",
        }
    }
}
impl fmt::Display for PublicationDataError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}
impl std::error::Error for PublicationDataError {}
fn key(value: &str) -> Text {
    Text(value.chars().map(u32::from).collect())
}
fn string(value: &str) -> Value {
    Value(Node::String(key(value)))
}
fn digest(value: &Value) -> Result<JournalDigest> {
    let value = crate::reservation_control::fingerprint(value)
        .map_err(|_| PublicationDataError::Fingerprint)?;
    Ok(JournalDigest::parse(&crate::digest::hex(&value)).expect("SHA256"))
}
pub struct PublicationFields<'a> {
    pub operation: &'a Operation,
    pub profile: &'a ResourceProfile,
    pub employee: &'a ClaimEmployee,
    pub baseline: &'a OriginalSourceBaseline,
    pub before: &'a EffectiveWorkerConfig,
}
/// Bounded finite receipt DATA, losslessly copying employee/worker values.
/// Actual phase, journal ownership and native fences live in the application.
pub struct PublicationIntent {
    value: Value,
    before: ClaimEmployee,
    after: ClaimEmployee,
}
impl PublicationIntent {
    pub fn operation_id(&self) -> reverie_core::operations::JournalId {
        let Node::Object(value) = &self.value.0 else {
            unreachable!("closed publication")
        };
        let Some(Value(Node::String(value))) = value.get(&key("operationId")) else {
            unreachable!("closed publication ID")
        };
        let value = value
            .0
            .iter()
            .map(|&c| char::from_u32(c).expect("ASCII ID"))
            .collect::<String>();
        reverie_core::operations::JournalId::parse(&value).expect("checked operation ID")
    }
    pub fn from_observed_data(fields: PublicationFields<'_>) -> Result<Self> {
        let mut after = fields.employee.data().deep_clone();
        let Node::Object(row) = &mut after.0 else {
            unreachable!("checked selected row")
        };
        let binding = fields.profile.binding();
        row.insert(key("sessionId"), string(binding.target_session().as_str()));
        row.insert(
            key("sessionGeneration"),
            Value(Node::Number(crate::legacy_json::Number::Integer(
                binding.target_generation().get().to_string(),
            ))),
        );
        if let Some(value) = row.get_mut(&key("runtimeRecipe")) {
            recipe::fresh(value)?;
        }
        let operation = fields.operation.data();
        let profile = crate::profiles_v1::data(fields.profile)
            .map_err(|_| PublicationDataError::Fingerprint)?;
        let value = Value(Node::Object(
            [
                (
                    key("schema"),
                    string("reverie-resource-publication-intent-v2"),
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
                (key("beforeEmployee"), fields.employee.data().deep_clone()),
                (key("afterEmployee"), after.deep_clone()),
                (key("nativeBaseline"), fields.baseline.data().deep_clone()),
                (
                    key("beforeConfigDigest"),
                    string(digest(fields.before.as_value())?.as_str()),
                ),
                (key("state"), string("PREPARING")),
            ]
            .into_iter()
            .collect(),
        ));
        digest(&value)?;
        if crate::worker_config::compact_data(&value).len() > crate::operations_v1::MAX_BYTES {
            return Err(PublicationDataError::Bound);
        }
        Ok(Self {
            value,
            before: fields
                .employee
                .projected(fields.employee.data().deep_clone()),
            after: fields.employee.projected(after),
        })
    }
    pub fn canonical_bytes(&self) -> Vec<u8> {
        crate::worker_config::compact_data(&self.value)
    }
    pub fn digest(&self) -> JournalDigest {
        digest(&self.value).expect("checked finite bounded receipt")
    }
    pub fn matches_metadata(&self, metadata: &Metadata) -> bool {
        self.value.python_eq(metadata.as_value())
    }
    pub fn before_employee(&self) -> &ClaimEmployee {
        &self.before
    }
    pub fn after_employee(&self) -> &ClaimEmployee {
        &self.after
    }
}
