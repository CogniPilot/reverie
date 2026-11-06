//! Actual canonical profile staging followed by the source's OLD6 native
//! effective-policy observations. This changes neither file nor broker state.
use super::preparation_phase::PublicationPhase;
use super::*;
use reverie_contracts::{
    broker_resources::{self, ResourceConfigError},
    profiles_v1::{self, ProfileDigest},
    resource_reload::{FrozenOldPolicy, OldPolicyStart},
    worker_config::{self, EffectiveWorkerConfig},
};
use reverie_core::{
    resource_projection::ProfileStageRequest,
    revision::{ObservedProfileVersion, ProfileVersion},
};
use reverie_store::{
    profiles::ProfileStore,
    storage_identity::{self, StorageKind},
};
use std::collections::BTreeMap;

/// A candidate observed under this real retained preparation. Its data never
/// prove that the policy file was published, reloaded, or a laptop started.
pub struct StagedPreparation {
    config: EffectiveWorkerConfig,
    version: ProfileVersion,
    digest: ProfileDigest,
}
impl StagedPreparation {
    pub fn configuration(&self) -> &EffectiveWorkerConfig {
        &self.config
    }
    pub fn profile_version(&self) -> ProfileVersion {
        self.version
    }
    pub fn profile_digest(&self) -> &ProfileDigest {
        &self.digest
    }
}
impl RetainedPreparation {
    pub fn stage_configuration(&self) -> Result<StagedPreparation> {
        need(
            self.store.is_some(),
            "RESOURCE_PREPARATION_ACTIVE_HANDLE_REQUIRED",
        )?;
        need(self.published, "RESOURCE_PREPARATION_PUBLICATION_REQUIRED")?;
        let admission = self.gate.admit(AdmissionBounds::default())?;
        match self.stage_body() {
            Ok(value) => finalized(
                Ok(value),
                admission.finish_preparation(self, PublicationPhase::After),
            ),
            // The context-manager source skips post-yield observations on a
            // body error, but always checks admission's descriptor cleanup.
            Err(error) => admission.conclude(Err(error)),
        }
    }
    fn stage_body(&self) -> Result<StagedPreparation> {
        let profiles =
            ProfileStore::open(reservation_control::profile_directory(&self.gate.config)?)?;
        let result = (|| {
            let snapshot = profiles.snapshot()?;
            let profile = self.profile();
            let binding = profile.binding();
            need(
                snapshot
                    .profiles()
                    .get(binding.employee())
                    .is_some_and(|actual| profiles_v1::equivalent(actual, profile)),
                "RESOURCE_PREPARATION_PROFILE_CHANGED",
            )?;
            let owners = BTreeMap::from([
                (
                    binding.current_session().clone(),
                    binding.employee().clone(),
                ),
                (binding.target_session().clone(), binding.employee().clone()),
            ]);
            let request = ProfileStageRequest::try_new(
                binding.employee().clone(),
                binding.clone(),
                snapshot.revision(),
                ObservedProfileVersion::try_new(profile.version().get())?,
                &owners,
            )
            .map_err(ResourceConfigError::from)?;
            let captured = broker_resources::decode(&worker_config::encode_config(
                self.source_configuration(),
            ))?;
            Ok(
                crate::resource_staging::stage_config(&profiles, captured, &request)?
                    .configuration()
                    .clone(),
            )
        })();
        let staged = finalized(result, profiles.close().map_err(Into::into))?;
        let config = self.compatibility_candidate(staged)?;
        Ok(StagedPreparation {
            config,
            version: self.profile().version(),
            digest: profiles_v1::profile_digest(self.profile())
                .map_err(crate::resource_staging::ResourceServiceError::from)?,
        })
    }
    fn compatibility_candidate(
        &self,
        projected: EffectiveWorkerConfig,
    ) -> Result<EffectiveWorkerConfig> {
        let binding = self.profile().binding();
        let start = OldPolicyStart::capture(
            self.source_configuration().clone(),
            projected,
            binding.current_session().clone(),
            binding.target_session().clone(),
        )?;
        let paths =
            storage_identity::storage_paths(&self.gate.identity, binding.current_session())?;
        need(
            paths.kind() == StorageKind::Employee,
            "RESERVATION_CURRENT_EMPLOYEE_REQUIRED",
        )?;
        let freeze = start.for_employee(paths.employee().expect("employee storage invariant"))?;
        let old = crate::resource_staging::effective_config(
            freeze.before().clone(),
            binding.current_session(),
        )?;
        let candidate = freeze.freeze(&old)?;
        // policy_digest(config,sid) resolves again in the source: the first
        // effective read freezes OLD6; these fresh reads prove policy equality.
        let before = crate::resource_staging::effective_config(
            candidate.before().clone(),
            binding.current_session(),
        )?;
        let after = crate::resource_staging::effective_config(
            candidate.candidate().clone(),
            binding.current_session(),
        )?;
        candidate.assert_old_policy(&before, &after)?;
        for sid in candidate.peer_sessions() {
            let sid = sid?;
            let before =
                crate::resource_staging::effective_config(candidate.before().clone(), &sid)?;
            let after =
                crate::resource_staging::effective_config(candidate.candidate().clone(), &sid)?;
            FrozenOldPolicy::assert_peer(&before, &after)?;
        }
        Ok(candidate.into_configuration())
    }
}
