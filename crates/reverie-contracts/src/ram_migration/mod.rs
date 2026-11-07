//! Exact RAM migration selection DATA. Parsing, deriving or hashing this value
//! grants no owner, admission, cgroup write, launch or capacity permission.
mod record;
use crate::{
    broker_resources,
    device_policy::memory,
    legacy_json::{Node, Text, Value},
    profiles_v1,
    reservation_engine::NativeLimitBinding,
    resource_config,
    worker_config::{self, EffectiveWorkerConfig},
};
use reverie_core::{
    device_policy::{ProjectedMemoryPolicy, SoftMemoryPolicy},
    operations::{JournalDigest, MIB},
    profiles::ResourceProfile,
    resources::{BudgetMode, ResourcePolicy, ResourceTemplate},
};
use std::{collections::BTreeMap, fmt};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RamMigrationError {
    Pool,
    Source,
    Memory,
    Profile,
    Target,
    Fingerprint,
}
impl RamMigrationError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Pool => "RAM_MIGRATION_BURST_POOL_REQUIRED",
            Self::Source => "RAM_MIGRATION_SOURCE_POLICY_CHANGED",
            Self::Memory => "RAM_MIGRATION_MEMORY_POLICY",
            Self::Profile => "RAM_MIGRATION_PROFILE_CHANGED",
            Self::Target => "RAM_MIGRATION_TARGET_POLICY_CHANGED",
            Self::Fingerprint => "RAM_MIGRATION_FINGERPRINT",
        }
    }
}
impl fmt::Display for RamMigrationError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for RamMigrationError {}
type Result<T> = std::result::Result<T, RamMigrationError>;

/// The actual caller must approve this exact digest and independently retain
/// its native source, current owner, canonical claim and pool/provisioning owner.
pub struct RamMigrationPolicy {
    profile: ResourceProfile,
    target: ResourcePolicy,
    memory: ProjectedMemoryPolicy,
    bytes: Vec<u8>,
    digest: JournalDigest,
}
impl RamMigrationPolicy {
    /// Derive from already observed source DATA. The application must supply
    /// its SAME retained original baseline and freshly checked profile/source.
    pub fn from_observed(
        profile: &ResourceProfile,
        source: &NativeLimitBinding,
        effective: &EffectiveWorkerConfig,
    ) -> Result<Self> {
        let approved = profile.resources();
        if approved.budget_mode() != BudgetMode::Admission
            || approved.memory_mib() == 0
            || approved.memory_mib() != approved.pool_memory_mib()
            || approved.cpus().nano_cpus() != 0
        {
            return Err(RamMigrationError::Pool);
        }
        // The legacy approval/reservation stays Admission and HARD. Only this
        // separate new-purpose selection projects the target into Pool mode.
        let target = ResourcePolicy::try_new(
            BudgetMode::Pool,
            approved.memory_mib(),
            approved.pids_limit(),
            approved.cpus(),
            approved.pool_memory_mib(),
            approved.pool_tasks_max(),
        )
        .map_err(|_| RamMigrationError::Pool)?;
        let original = resource_config::checked_effective_policy(effective)
            .map_err(|_| RamMigrationError::Source)?;
        if original.memory_mib() == 0
            || *source.memory()
                != reverie_core::decimal::UnsignedInteger::from_u64(
                    u64::from(original.memory_mib()) * MIB,
                )
        {
            return Err(RamMigrationError::Source);
        }
        let prior = prior_memory(effective, &original)?;
        let high = prior
            .as_ref()
            .and_then(|prior| prior.policy().memory_high_mib())
            .unwrap_or(original.memory_mib());
        let swap = prior.as_ref().map_or(0, |prior| prior.policy().swap_mib());
        let pool = prior
            .as_ref()
            .map_or(0, ProjectedMemoryPolicy::swap_pool_mib);
        let memory = SoftMemoryPolicy::try_new(Some(high), swap)
            .and_then(|policy| policy.project(pool, Some(&target)))
            .map_err(|_| RamMigrationError::Memory)?;
        let (bytes, digest) = record::encode(profile, &target, source, effective, &memory)?;
        Ok(Self {
            profile: profile.clone(),
            target,
            memory,
            bytes,
            digest,
        })
    }
    pub fn digest(&self) -> &JournalDigest {
        &self.digest
    }
    pub fn canonical_bytes(&self) -> &[u8] {
        &self.bytes
    }
    pub fn profile(&self) -> &ResourceProfile {
        &self.profile
    }
    pub fn memory(&self) -> &ProjectedMemoryPolicy {
        &self.memory
    }
    pub fn target_resources(&self) -> &ResourcePolicy {
        &self.target
    }
    /// Modify only the selected unused target SID in an already staged DATA
    /// candidate. No EID policy, peer, old SID, profile or domain is rewritten.
    pub fn apply_to_staged(&self, staged: EffectiveWorkerConfig) -> Result<EffectiveWorkerConfig> {
        let captured = resource_config::ResourceConfiguration::capture(staged.clone())
            .map_err(|_| RamMigrationError::Target)?;
        let target = self.profile.binding().target_session();
        let projected = captured
            .project(target, None)
            .map_err(|_| RamMigrationError::Target)?;
        let actual = resource_config::checked_effective_policy(&projected)
            .map_err(|_| RamMigrationError::Target)?;
        if actual != *self.profile.resources() {
            return Err(RamMigrationError::Target);
        }
        let mut value = staged.into_value();
        let Node::Object(fields) = &mut value.0 else {
            unreachable!("worker object")
        };
        let Some(Value(Node::Object(sessions))) = fields.get_mut(&key("sessionResources")) else {
            return Err(RamMigrationError::Target);
        };
        if !sessions.contains_key(&key(target.as_str())) {
            return Err(RamMigrationError::Target);
        }
        sessions.insert(
            key(target.as_str()),
            crate::session_resources_v2::wrap(
                broker_resources::resource_fields(&ResourceTemplate::from(&self.target)),
                Some(memory::projected_value(&self.memory)),
            ),
        );
        let Node::Object(fields) = std::mem::replace(&mut value.0, Node::Null) else {
            unreachable!("worker object")
        };
        Ok(EffectiveWorkerConfig::from_object(fields))
    }
}
fn key(value: &str) -> Text {
    Text(value.chars().map(u32::from).collect())
}
fn prior_memory(
    effective: &EffectiveWorkerConfig,
    resources: &reverie_core::resources::ResourcePolicy,
) -> Result<Option<ProjectedMemoryPolicy>> {
    let Node::Object(fields) = &effective.as_value().0 else {
        unreachable!("worker object")
    };
    let Some(prior) = fields.get(&key("laptopMemoryPolicy")) else {
        return Ok(None);
    };
    let wrapped = crate::session_resources_v2::wrap(
        broker_resources::resource_fields(&ResourceTemplate::from(resources)),
        Some(prior.deep_clone()),
    );
    crate::session_resources_v2::decode(&wrapped)
        .map(|selected| selected.expect("versioned memory").memory)
        .map_err(|_| RamMigrationError::Memory)
}
