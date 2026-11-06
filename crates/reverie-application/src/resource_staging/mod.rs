//! Existing ProfileStore.stage_config workflow with checked lock finalization.
mod effective;
mod error;
#[cfg(test)]
mod tests;
pub use effective::effective_config;
pub use error::ResourceServiceError;
use error::Result;
use reverie_contracts::{
    broker_resources::{BrokerResourceConfig, StagedBrokerResources},
    profiles_v1::{self, ProfileDigest},
    worker_config::{self, EffectiveWorkerConfig, WorkerConfigDigest, WorkerPolicyDigest},
};
use reverie_core::{
    ids::ProfileSessionId,
    resource_projection::{ProfileStageRequest, StagedResourceProjection},
};
use reverie_store::profiles::ProfileStore;

/// A fully resolved candidate whose profile read custody was finalized. It is
/// not an owner grant, native permit, admission reservation or persisted change.
pub struct StagedProfileConfiguration {
    config: EffectiveWorkerConfig,
    effective: EffectiveWorkerConfig,
    staged: StagedResourceProjection,
    profile_digest: ProfileDigest,
    effective_config_digest: WorkerConfigDigest,
    effective_policy_digest: WorkerPolicyDigest,
}
impl StagedProfileConfiguration {
    /// Protected application data. Never publish full config as a GUI response.
    pub fn configuration(&self) -> &EffectiveWorkerConfig {
        &self.config
    }
    pub fn effective_configuration(&self) -> &EffectiveWorkerConfig {
        &self.effective
    }
    pub fn resources(&self) -> &StagedResourceProjection {
        &self.staged
    }
    pub fn profile_digest(&self) -> &ProfileDigest {
        &self.profile_digest
    }
    pub fn effective_config_digest(&self) -> &WorkerConfigDigest {
        &self.effective_config_digest
    }
    pub fn effective_policy_digest(&self) -> &WorkerPolicyDigest {
        &self.effective_policy_digest
    }
}
/// Retain the existing real profile lock through resource staging, all native
/// feature observations and hashing. Every success/error path checks finish().
/// The caller still supplies canonical binding/owner inputs from its admitted
/// worker domain; this function never authenticates a browser/agent request.
/// The borrowed ProfileStore remains the caller's responsibility: check its
/// close result before any terminal operation/native acknowledgement as well.
pub fn stage_config(
    store: &ProfileStore,
    config: BrokerResourceConfig,
    request: &ProfileStageRequest,
) -> Result<StagedProfileConfiguration> {
    stage_using(store, config, request, effective_config)
}
fn stage_using(
    store: &ProfileStore,
    config: BrokerResourceConfig,
    request: &ProfileStageRequest,
    resolve: impl FnOnce(EffectiveWorkerConfig, &ProfileSessionId) -> Result<EffectiveWorkerConfig>,
) -> Result<StagedProfileConfiguration> {
    let guard = store.locked_read()?;
    let value = config
        .stage(guard.document(), request)
        .map_err(ResourceServiceError::from)
        .and_then(|staged| finish_candidate(staged, resolve));
    error::finalized(value, guard.finish())
}
fn finish_candidate(
    staged: StagedBrokerResources,
    resolve: impl FnOnce(EffectiveWorkerConfig, &ProfileSessionId) -> Result<EffectiveWorkerConfig>,
) -> Result<StagedProfileConfiguration> {
    let (config, staged) = staged.into_configuration();
    // Retain the unprojected candidate for the existing broker config result.
    // Clone its actual data nodes, never through JSON serialization/reparsing.
    let effective = resolve(config.clone(), staged.target_session())?;
    Ok(StagedProfileConfiguration {
        profile_digest: profiles_v1::profile_digest(staged.profile())?,
        effective_config_digest: worker_config::config_digest(&effective),
        effective_policy_digest: worker_config::policy_digest(&effective),
        config,
        effective,
        staged,
    })
}
