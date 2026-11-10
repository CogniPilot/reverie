use super::*;
use crate::worker_validation::{WorkerValidationHostError, load_owner_configuration};
use reverie_contracts::{
    reservation_engine::ReservationConfiguration,
    worker_config::{EffectiveWorkerConfig, WorkerConfigDigest, config_digest},
    worker_pool::WorkerPoolProvider,
};
use std::path::{Path, PathBuf};

pub(super) struct RegisteredBirthSource {
    path: PathBuf,
    digest: WorkerConfigDigest,
    kind: SourceKind,
}

pub(super) enum SourceKind {
    Installation,
    Restoration,
}

impl RegisteredBirthSource {
    pub(super) fn capture(path: &Path, kind: SourceKind) -> Result<(Self, EffectiveWorkerConfig)> {
        let configuration = load(path)?;
        if matches!(kind, SourceKind::Installation) {
            need(
                provider(&configuration)?.is_none_or(|provider| provider.member_revision() == 0),
                "WORKER_POOL_COMMITTED_BIRTH_REQUIRED",
            )?;
        }
        let owner = Self {
            path: path.to_owned(),
            digest: config_digest(&configuration),
            kind,
        };
        owner.assert_committed(&configuration)?;
        Ok((owner, configuration))
    }

    pub(super) fn assert_current(&self) -> Result<()> {
        let configuration = load(&self.path)?;
        need(
            config_digest(&configuration) == self.digest,
            "WORKER_POOL_BIRTH_SOURCE_CHANGED",
        )?;
        self.assert_committed(&configuration)
    }

    fn assert_committed(&self, configuration: &EffectiveWorkerConfig) -> Result<()> {
        if matches!(self.kind, SourceKind::Restoration) {
            let config = ReservationConfiguration::capture(configuration.clone());
            let pending = crate::reservation_control::pending_present(&config)
                .map_err(|error| PoolError::Refused(error.code()))?;
            need(!pending, "WORKER_POOL_BIRTH_SOURCE_PENDING")?;
        }
        Ok(())
    }
}

fn load(source: &Path) -> Result<EffectiveWorkerConfig> {
    load_owner_configuration(source).map_err(|error| match error {
        WorkerValidationHostError::Observation(error) => PoolError::Observation(error),
        other => PoolError::Refused(other.code()),
    })
}

fn provider(configuration: &EffectiveWorkerConfig) -> Result<Option<WorkerPoolProvider>> {
    WorkerPoolProvider::from_config(configuration)
        .map_err(|_| PoolError::Refused("WORKER_POOL_PROVIDER_INVALID"))
}

impl BrokerBootstrapBinding {
    /// Capture an unopened metadata owner from this SAME qualified process.
    /// The caller must store it before publish and retain both actual owners.
    /// This creates no host-administration or controller-activation capability.
    pub fn prepare_birth_publication(
        &mut self,
        runtime: &WorkerRuntime,
        source: &Path,
        policy: WorkerPoolPolicy,
        end: Instant,
    ) -> Result<ControllerBirthPublication> {
        self.assert_registered_source(runtime, source, end)?;
        let (selection, _) = RegisteredBirthSource::capture(source, SourceKind::Installation)?;
        let birth = self.birth_document_data(runtime, policy, end)?;
        let owner = ControllerBirthPublication::unopened(runtime, birth.into(), selection, end)?;
        self.assert_registered_source(runtime, source, end)?;
        Ok(owner)
    }

    /// Capture the exact committed policy from the registered loader source.
    /// This preparation publishes no file and supplies no restart authority.
    pub fn prepare_restored_birth_publication(
        &mut self,
        runtime: &WorkerRuntime,
        source: &Path,
        retained_anchor: Option<RetainedPoolAnchor>,
        end: Instant,
    ) -> Result<ControllerBirthPublication> {
        self.assert_registered_source(runtime, source, end)?;
        let (selection, configuration) =
            RegisteredBirthSource::capture(source, SourceKind::Restoration)?;
        let provider = provider(&configuration)?.ok_or(PoolError::Refused(
            "WORKER_POOL_INSTALLED_PROVIDER_REQUIRED",
        ))?;
        let birth = self.birth_document_data(runtime, provider.policy().clone(), end)?;
        let birth =
            ControllerServiceBirth::from_installed_provider(birth, &provider, retained_anchor)
                .map_err(|_| PoolError::Refused("WORKER_POOL_RESTORED_BIRTH_INVALID"))?;
        let owner = ControllerBirthPublication::unopened(runtime, birth, selection, end)?;
        self.assert_registered_source(runtime, source, end)?;
        Ok(owner)
    }
}
