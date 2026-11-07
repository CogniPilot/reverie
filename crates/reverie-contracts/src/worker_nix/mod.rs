//! Fixed private Nix preparation DATA and purpose codecs. No process/engine
//! command endpoint, owner grant, running intent or laptop start permit.
mod engine;
mod markers;
pub use engine::{
    NixHelperState, NixPreviousHelper, created_identity, diagnostics_tail, helper_state,
    image_supports_private_store,
};
mod prepare;
use crate::{
    legacy_json::{Node, Text, Value},
    storage_identity::MetadataText,
    worker_config::EffectiveWorkerConfig,
};
pub use markers::{NixMigrationMarker, validate_rollback_text};
pub use prepare::NixPreparationArguments;
use std::{collections::BTreeMap, fmt};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NixDataError {
    Configuration,
    Json,
    Migration,
    Rollback,
    Image,
    PreviousHelper,
    HelperState,
    PreviousRunning,
    Container,
}
impl fmt::Display for NixDataError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "NIX_PREPARATION_{self:?}")
    }
}
impl std::error::Error for NixDataError {}
type Result<T> = std::result::Result<T, NixDataError>;
type Object = BTreeMap<Text, Value>;
fn key(name: &str) -> Text {
    Text(name.chars().map(u32::from).collect())
}
fn object(value: &Value) -> Option<&Object> {
    if let Node::Object(value) = &value.0 {
        Some(value)
    } else {
        None
    }
}
fn field<'a>(object: &'a Object, name: &str) -> Option<&'a Value> {
    object.get(&key(name))
}
fn string(value: Option<&Value>) -> Result<MetadataText> {
    let Some(Value(Node::String(value))) = value else {
        return Err(NixDataError::Configuration);
    };
    Ok(MetadataText::from_text(value.clone()))
}
/// Capture only. Image absence may short-circuit before unrelated configuration
/// fields or filesystem selection; installing callers supply validated worker
/// UID/mount/deployment shapes, not a second request-selected configuration.
pub struct NixConfiguration(EffectiveWorkerConfig);
impl NixConfiguration {
    pub fn capture(source: &EffectiveWorkerConfig) -> Self {
        Self(source.clone())
    }
    pub fn source(&self) -> &EffectiveWorkerConfig {
        &self.0
    }
    fn fields(&self) -> &Object {
        object(self.0.as_value()).expect("worker object invariant")
    }
    pub fn image(&self) -> Result<MetadataText> {
        string(field(self.fields(), "image"))
    }
    pub fn deployment(&self) -> Result<MetadataText> {
        string(field(self.fields(), "deployment"))
    }
    pub fn state_root(&self) -> Result<MetadataText> {
        string(field(self.fields(), "stateRoot"))
    }
    pub fn scratch_root(&self) -> Result<MetadataText> {
        string(field(self.fields(), "scratchRoot"))
    }
    pub fn uid(&self) -> Result<u32> {
        self.integer("uid")
    }
    fn integer(&self, name: &str) -> Result<u32> {
        match field(self.fields(), name) {
            Some(Value(Node::Number(crate::legacy_json::Number::Integer(value)))) => {
                value.parse().map_err(|_| NixDataError::Configuration)
            }
            _ => Err(NixDataError::Configuration),
        }
    }
}
