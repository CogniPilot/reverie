//! Closed resource-purpose DATA. Only the actual native website/owner actor
//! can authenticate a channel or authorize maintenance; these values cannot.
mod facts;
mod image_time;
mod metadata;
mod native_client;
mod pool_image_inputs;
mod process;
pub use pool_image_inputs::{
    POOL_IMAGE_INPUT_FACTORY_FILES, POOL_IMAGE_INPUTS_PURPOSE, PoolImageInputsData, PoolImageRole,
};
#[cfg(test)]
mod pool_image_inputs_tests;
mod protocol;
pub use protocol::{
    CurrentFleetMaintenanceOwner, CurrentFleetPreviewViewer, CurrentPoolInstallationConsent,
    CurrentPoolInstallationViewer, CurrentResourceOwner, FLEET_MAINTENANCE_PURPOSE,
    FleetMaintenanceAction, FleetMaintenanceRequest, FleetPreviewRequest,
    POOL_INSTALLATION_CONSENT_PURPOSE, POOL_INSTALLATION_REQUEST_PURPOSE,
    POOL_REGISTRATION_PURPOSE, PoolInstallationConsentRequest, PoolInstallationOfferViewData,
    PoolInstallationRequestData, PoolInstallationViewRequest, RAM_POOL_PURPOSE,
    RamLaunchCommandData, RamPreviewFields, ResourceContinuationRequest, ResourceContinuationVerb,
    ResourceOperationRequest, ResourceOwnerPrincipal, ResourceRequestSelection,
    decode_fleet_maintenance_hello, decode_pool_registration_hello, decode_ram_pool_hello,
};
mod provenance;
mod worker_image;
pub use worker_image::WorkerImageProvenance;
mod settings;
mod setup;
pub use setup::history as actor_setup_history;
pub use setup::{ActorSetupDataError, ActorSetupTransition};
#[cfg(test)]
mod tests;
mod website;
use crate::legacy_json::{self, Node, Number, Text, Value};
pub use facts::{ArtifactReference, EngineSelection, InstalledFactsDocument};
pub use metadata::{
    EngineMetadata, MAX_ENGINE_BODY, QualifiedWebsiteMetadata, validate_protected_website_settings,
};
pub use native_client::NativeResourceClientManifest;
pub use process::{ProcessStatData, require_peer_kernel_status};
pub use provenance::{
    InvocationKind, InvocationSelection, WebsiteImageProvenance, WebsiteProgramGraph,
};
use reverie_core::{PythonText, decimal::UnsignedInteger, operations::JournalDigest};
pub use settings::ResourceActorSettings;
use std::{collections::BTreeMap, fmt};
pub use website::{CodeFile, ProgramSelection, WebsiteSelection};

pub const PURPOSE: &str = "resource-replacement-v1";
#[derive(Clone, Debug)]
pub struct ResourceActorDataError(&'static str);
impl ResourceActorDataError {
    pub fn code(&self) -> &'static str {
        self.0
    }
}
impl fmt::Display for ResourceActorDataError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str(self.0)
    }
}
impl std::error::Error for ResourceActorDataError {}
type Result<T> = std::result::Result<T, ResourceActorDataError>;
fn need(value: bool, code: &'static str) -> Result<()> {
    if value {
        Ok(())
    } else {
        Err(ResourceActorDataError(code))
    }
}
fn key(value: &str) -> Text {
    Text(value.bytes().map(u32::from).collect())
}
fn object(value: &Value) -> Result<&BTreeMap<Text, Value>> {
    match &value.0 {
        Node::Object(fields) => Ok(fields),
        _ => Err(ResourceActorDataError("RESOURCE_INSTALL_CLOSED_SCHEMA")),
    }
}
fn closed(value: &Value, names: &[&str]) -> Result<()> {
    let fields = object(value)?;
    need(
        fields.len() == names.len() && names.iter().all(|name| fields.contains_key(&key(name))),
        "RESOURCE_INSTALL_CLOSED_SCHEMA",
    )
}
fn field<'a>(value: &'a Value, name: &str) -> Result<&'a Value> {
    object(value)?
        .get(&key(name))
        .ok_or(ResourceActorDataError("RESOURCE_INSTALL_CLOSED_SCHEMA"))
}
fn text(value: &Value) -> Result<PythonText> {
    match &value.0 {
        Node::String(value) => Ok(PythonText::try_new(value.0.clone()).expect("JSON codepoints")),
        _ => Err(ResourceActorDataError("RESOURCE_INSTALL_TEXT_REQUIRED")),
    }
}
fn scalar(value: &Value) -> Result<String> {
    text(value)?
        .codepoints()
        .iter()
        .copied()
        .map(char::from_u32)
        .collect::<Option<_>>()
        .ok_or(ResourceActorDataError("RESOURCE_INSTALL_SCALAR_REQUIRED"))
}
fn unsigned(value: &Value) -> Result<UnsignedInteger> {
    match &value.0 {
        Node::Number(Number::Integer(value)) => UnsignedInteger::parse(value)
            .ok_or(ResourceActorDataError("RESOURCE_INSTALL_INTEGER_REQUIRED")),
        _ => Err(ResourceActorDataError("RESOURCE_INSTALL_INTEGER_REQUIRED")),
    }
}
fn digest(value: &Value) -> Result<JournalDigest> {
    JournalDigest::parse(&scalar(value)?)
        .map_err(|_| ResourceActorDataError("RESOURCE_INSTALL_ARTIFACT_DIGEST"))
}
fn array(value: &Value) -> Result<&[Value]> {
    match &value.0 {
        Node::Array(values) => Ok(values),
        _ => Err(ResourceActorDataError("RESOURCE_INSTALL_ARRAY_REQUIRED")),
    }
}
/// Original worker.py Q uses ordinary json.loads(bytes) dictionary equality.
/// It accepts last duplicate values and Python True/1/1.0 equality; the later
/// framed protocol has its own stricter canonical/duplicate rules.
pub fn decode_initial_hello(raw: &[u8]) -> Result<()> {
    let value = legacy_json::decode_rootless_profile(raw)
        .map_err(|_| ResourceActorDataError("Protected resource purpose is unavailable"))?;
    let expected = legacy_json::decode_rootless_profile(
        br#"{"purpose":"resource-replacement-v1","version":1}"#,
    )
    .expect("fixed Q hello");
    need(
        value.python_eq(&expected),
        "Protected resource purpose is unavailable",
    )
}
