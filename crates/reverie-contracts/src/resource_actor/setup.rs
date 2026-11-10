//! First actor selector/domain transition DATA. No installer, private file,
//! OS/website authority, pending, stopped-service or launch proof follows.
use super::*;
use crate::{
    reservation_control::{self, ControlBinding, ControlDataError},
    reservation_engine::ReservationConfiguration,
    storage_identity::OrderedMetadata,
    worker_config::{self, EffectiveWorkerConfig, WorkerConfigError},
};
use reverie_core::posix_path::PosixPath;
pub mod history;
mod raw;
pub enum ActorSetupDataError {
    Refused(&'static str),
    Configuration(WorkerConfigError),
    Control(ControlDataError),
    Actor(ResourceActorDataError),
    Operation(reverie_core::operations::OperationError),
    Profiles(crate::profiles_v1::CodecError),
}
impl ActorSetupDataError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Refused(code) => code,
            Self::Configuration(cause) => cause.code(),
            Self::Control(cause) => cause.code(),
            Self::Actor(cause) => cause.code(),
            Self::Operation(cause) => cause.code(),
            Self::Profiles(cause) => cause.code(),
        }
    }
}
impl fmt::Debug for ActorSetupDataError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.debug_tuple("ActorSetupDataError")
            .field(&self.code())
            .finish()
    }
}
impl fmt::Display for ActorSetupDataError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for ActorSetupDataError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Configuration(cause) => Some(cause),
            Self::Control(cause) => Some(cause),
            Self::Actor(cause) => Some(cause),
            Self::Operation(cause) => Some(cause),
            Self::Profiles(cause) => Some(cause),
            Self::Refused(_) => None,
        }
    }
}
type SetupResult<T> = std::result::Result<T, ActorSetupDataError>;
pub struct ActorSetupTransition {
    before: EffectiveWorkerConfig,
    after: EffectiveWorkerConfig,
    before_binding: ControlBinding,
    after_binding: ControlBinding,
    bytes: Vec<u8>,
    actor_path: PosixPath,
}
impl ActorSetupTransition {
    pub fn pending_bytes(
        &self,
        operation: &reverie_core::operations::JournalId,
        preview: &JournalDigest,
        facts: &JournalDigest,
    ) -> Vec<u8> {
        let mut values = BTreeMap::new();
        let before = self.before_binding.domain().to_hex();
        let after = self.after_binding.domain().to_hex();
        for (name, value) in [
            ("purpose", "native-resource-actor-setup-v1"),
            ("operationId", operation.as_str()),
            ("previewDigest", preview.as_str()),
            ("factsDigest", facts.as_str()),
            ("beforeDomain", before.as_str()),
            ("afterDomain", after.as_str()),
        ] {
            values.insert(
                key(name),
                Value(Node::String(Text(value.chars().map(u32::from).collect()))),
            );
        }
        values.insert(
            key("version"),
            Value(Node::Number(Number::Integer("1".into()))),
        );
        worker_config::compact_data(&Value(Node::Object(values)))
    }
    pub fn matches_pending_metadata(
        &self,
        metadata: &OrderedMetadata,
        operation: &reverie_core::operations::JournalId,
        preview: &JournalDigest,
        facts: &JournalDigest,
    ) -> bool {
        legacy_json::decode_strict_bytes(&self.pending_bytes(operation, preview, facts))
            .is_ok_and(|value| value.python_eq(metadata.as_value()))
    }
    pub fn prepare(
        before: &EffectiveWorkerConfig,
        raw: &[u8],
        binding: &ControlBinding,
    ) -> SetupResult<Self> {
        let decoded = worker_config::decode(raw).map_err(ActorSetupDataError::Configuration)?;
        need_setup(
            worker_config::equivalent(&decoded, before)
                && decoded.session_resource_order() == before.session_resource_order(),
            "ACTOR_SETUP_CONFIGURATION_CHANGED",
        )?;
        need_setup(
            reservation_control::domain_digest(before).map_err(ActorSetupDataError::Control)?
                == *binding.domain(),
            "ACTOR_SETUP_DOMAIN_CHANGED",
        )?;
        let selected = ReservationConfiguration::capture(before.clone());
        let actor_path = selected
            .control_paths()
            .map_err(|_| ActorSetupDataError::Refused("ACTOR_SETUP_FIXED_PATH"))?
            .root()
            .join(&PosixPath::from_scalar_text("resource-actor.json"));
        let mut after = before.clone();
        after
            .select_resource_actor(&actor_path)
            .ok_or(ActorSetupDataError::Refused("ACTOR_SETUP_ALREADY_SELECTED"))?;
        ResourceActorSettings::capture(&after).map_err(ActorSetupDataError::Actor)?;
        let bytes = raw::insert_selector(raw, &actor_path)?;
        let decoded = worker_config::decode(&bytes).map_err(ActorSetupDataError::Configuration)?;
        need_setup(
            worker_config::equivalent(&decoded, &after)
                && decoded.session_resource_order() == after.session_resource_order(),
            "ACTOR_SETUP_CONFIGURATION_ENCODING",
        )?;
        let after_binding = binding
            .configuration_rebound(&after)
            .map_err(ActorSetupDataError::Control)?;
        Ok(Self {
            before: before.clone(),
            after,
            before_binding: binding.clone(),
            after_binding,
            bytes,
            actor_path,
        })
    }
    /// Explicit metadata refresh of the already selected fixed actor. The
    /// complete configuration and binding remain identical.
    pub fn prepare_refresh(
        before: &EffectiveWorkerConfig,
        raw: &[u8],
        binding: &ControlBinding,
    ) -> SetupResult<Self> {
        let decoded = worker_config::decode(raw).map_err(ActorSetupDataError::Configuration)?;
        need_setup(
            worker_config::equivalent(&decoded, before)
                && decoded.session_resource_order() == before.session_resource_order()
                && reservation_control::domain_digest(before)
                    .map_err(ActorSetupDataError::Control)?
                    == *binding.domain(),
            "ACTOR_REFRESH_CONFIGURATION_CHANGED",
        )?;
        let selected =
            ResourceActorSettings::capture(before).map_err(ActorSetupDataError::Actor)?;
        Ok(Self {
            before: before.clone(),
            after: before.clone(),
            before_binding: binding.clone(),
            after_binding: binding.clone(),
            bytes: raw.to_vec(),
            actor_path: selected.path().clone(),
        })
    }
    pub fn is_refresh(&self) -> bool {
        worker_config::equivalent(&self.before, &self.after)
    }
    pub fn before(&self) -> &EffectiveWorkerConfig {
        &self.before
    }
    pub fn after(&self) -> &EffectiveWorkerConfig {
        &self.after
    }
    pub fn before_binding(&self) -> &ControlBinding {
        &self.before_binding
    }
    pub fn after_binding(&self) -> &ControlBinding {
        &self.after_binding
    }
    pub fn actor_path(&self) -> &PosixPath {
        &self.actor_path
    }
    pub fn configuration_bytes(&self) -> &[u8] {
        &self.bytes
    }
    pub fn binding_bytes(&self) -> Vec<u8> {
        worker_config::compact_data(&self.after_binding.configuration_data())
    }
    pub fn matches_before_configuration(&self, data: &OrderedMetadata) -> bool {
        self.before.as_value().python_eq(data.as_value())
    }
    pub fn matches_after_configuration(&self, data: &OrderedMetadata) -> bool {
        self.after.as_value().python_eq(data.as_value())
    }
    pub fn matches_before_binding(&self, data: &OrderedMetadata) -> bool {
        self.before_binding.matches_metadata(data)
    }
    pub fn matches_after_binding(&self, data: &OrderedMetadata) -> bool {
        self.after_binding.matches_metadata(data)
    }
}
fn need_setup(value: bool, code: &'static str) -> SetupResult<()> {
    value
        .then_some(())
        .ok_or(ActorSetupDataError::Refused(code))
}
