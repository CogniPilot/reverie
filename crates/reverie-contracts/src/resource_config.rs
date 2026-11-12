//! Existing resource_config data ordering and control-field stripping.
//! The application supplies native identity observations; none are inferred
//! from a requested employee ID or a staged profile binding.
use crate::broker_resources::{self, ResourceConfigError};
use crate::legacy_json::{Node, Text, Value};
use crate::storage_identity::MetadataText;
use crate::worker_config::EffectiveWorkerConfig;
use crate::worker_pool::WorkerPoolProvider;
use reverie_core::ids::{ProfileEmployeeId, ProfileSessionId};
use reverie_core::resource_projection::ResourceProjection;
use reverie_core::resources::{ResourcePolicy, ResourceTemplate};
use std::collections::BTreeMap;

const CONTROLS: [&str; 10] = [
    "sessionResources",
    "employeeResources",
    "resourceReservations",
    "browserJobPolicy",
    "resourceActorConfig",
    "employeeGpuGrants",
    "employeePerfPolicies",
    "employeeMemoryPolicies",
    "laptopSwapPoolMiB",
    "softLimitHelperSocket",
];
type Result<T> = std::result::Result<T, ResourceConfigError>;

pub struct ResourceConfiguration {
    source: EffectiveWorkerConfig,
    resources: ResourceProjection,
    worker_pool: Option<WorkerPoolProvider>,
}
impl ResourceConfiguration {
    /// Validate every configured resource entry, including unselected entries,
    /// without the profile-stage-only finite-value or compact-input bound.
    pub fn capture(source: EffectiveWorkerConfig) -> Result<Self> {
        let resources = broker_resources::projection(source.as_value())?;
        let worker_pool = WorkerPoolProvider::from_config(&source)
            .map_err(|_| ResourceConfigError::ResourceShape)?;
        Ok(Self {
            source,
            resources,
            worker_pool,
        })
    }
    /// Original launch selects the effective pool only by key presence.
    pub fn has_resource_maps(&self) -> bool {
        let root = root(&self.source);
        root.contains_key(&key("sessionResources")) || root.contains_key(&key("employeeResources"))
    }
    pub fn source(&self) -> &EffectiveWorkerConfig {
        &self.source
    }
    pub fn needs_storage_employee(&self, session: &ProfileSessionId) -> bool {
        !self.resources.sessions().contains_key(session) && !self.resources.employees().is_empty()
    }
    /// Select legacy SID first, then trusted storage EID, and override local
    /// pools only when resourceReservations is present (even if null/false).
    pub fn project(
        &self,
        session: &ProfileSessionId,
        storage_employee: Option<&ProfileEmployeeId>,
    ) -> Result<EffectiveWorkerConfig> {
        let mut value = self.source.as_value().deep_clone();
        let Node::Object(mut fields) = std::mem::replace(&mut value.0, Node::Null) else {
            unreachable!("worker object invariant");
        };
        for name in CONTROLS {
            fields.remove(&key(name));
        }
        if let Some(pool) = &self.worker_pool {
            pool.project_birth_fields(&mut fields)
                .map_err(|_| ResourceConfigError::ResourceShape)?;
        }
        let selected = self.resources.sessions().get(session).or_else(|| {
            storage_employee.and_then(|employee| self.resources.employees().get(employee))
        });
        if let Some(selected) = selected {
            let resolved = selected.resolve(self.resources.reservation_pool())?;
            fields.extend(broker_resources::resource_fields(&ResourceTemplate::from(
                &resolved,
            )));
        }
        Ok(EffectiveWorkerConfig::from_object(fields))
    }
    /// Settings from this captured worker config, not separate request paths.
    /// They are data for the native reader and carry no owner/effect authority.
    pub fn identity_settings(&self) -> Result<ResourceIdentitySettings> {
        ResourceIdentitySettings::capture_worker_config(&self.source)
    }
    /// The existing six-field profile projection, reusing the same global-pool
    /// presence rule as session/EID selection. No effective feature projection.
    pub fn project_profile_policy(&self, policy: &ResourcePolicy) -> Result<ResourcePolicy> {
        Ok(ResourceTemplate::from(policy).resolve(self.resources.reservation_pool())?)
    }
}
/// Python numeric equality is intentional here: CPU0 and0.0 have equal resource
/// ceilings even though their separate profile/policy digest bytes differ.
pub fn same_non_memory_resources(
    projected: &ResourcePolicy,
    effective: &EffectiveWorkerConfig,
) -> bool {
    let fields = broker_resources::resource_fields(&ResourceTemplate::from(projected));
    let current = root(effective);
    fields
        .iter()
        .filter(|(name, _)| !name.equals_ascii("memoryMiB"))
        .all(|(name, value)| {
            current
                .get(name)
                .is_some_and(|current| value.python_eq(current))
        })
}
/// Parse the already projected effective resource fields only when a consumer
/// needs a checked ceiling. Unselected and swap-only policies need no such read.
pub fn checked_effective_policy(config: &EffectiveWorkerConfig) -> Result<ResourcePolicy> {
    Ok(broker_resources::template_fields(root(config))?.resolve(None)?)
}
pub struct ResourceIdentitySettings {
    company: MetadataText,
    state: MetadataText,
    scratch: MetadataText,
    uid: u32,
}
impl ResourceIdentitySettings {
    /// Capture only identity DATA. Storage consumers must not validate unrelated
    /// resource maps before their original filesystem/registry phases.
    pub fn capture_worker_config(source: &EffectiveWorkerConfig) -> Result<Self> {
        let fields = root(source);
        let uid = match fields.get(&key("uid")) {
            Some(Value(Node::Number(crate::legacy_json::Number::Integer(uid)))) => uid
                .parse()
                .map_err(|_| ResourceConfigError::ResourceShape)?,
            _ => return Err(ResourceConfigError::ResourceShape),
        };
        Self::capture_known_uid(source, uid)
    }
    pub(crate) fn capture_known_uid(source: &EffectiveWorkerConfig, uid: u32) -> Result<Self> {
        let fields = root(source);
        Ok(Self {
            company: path(fields, "companyFile")?,
            state: path(fields, "stateRoot")?,
            scratch: path(fields, "scratchRoot")?,
            uid,
        })
    }
    pub fn company_file(&self) -> &MetadataText {
        &self.company
    }
    pub fn state_root(&self) -> &MetadataText {
        &self.state
    }
    pub fn scratch_root(&self) -> &MetadataText {
        &self.scratch
    }
    pub fn uid(&self) -> u32 {
        self.uid
    }
}
fn key(value: &str) -> Text {
    Text(value.chars().map(u32::from).collect())
}
fn root(value: &EffectiveWorkerConfig) -> &BTreeMap<Text, Value> {
    let Node::Object(fields) = &value.as_value().0 else {
        unreachable!("worker object invariant");
    };
    fields
}
fn path(fields: &BTreeMap<Text, Value>, name: &str) -> Result<MetadataText> {
    let Some(Value(Node::String(value))) = fields.get(&key(name)) else {
        return Err(ResourceConfigError::ResourceShape);
    };
    Ok(MetadataText::from_text(value.clone()))
}
