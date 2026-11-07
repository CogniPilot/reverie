//! Actual held-resource/native-observation bridge. This retains the one App
//! effective-config resolver; no plan or successful observation grants effects.
use super::*;
use crate::{resource_staging, worker_validation::ValidatedWorkerSnapshot};
use reverie_host::worker_launch::{CreateObservationError, ObservedCreatePlan};
#[derive(Debug)]
pub enum OwnedCreatePreparationError {
    Effective(resource_staging::ResourceServiceError),
    Storage(StorageWorkflowError),
    Observation(CreateObservationError),
}
impl std::fmt::Display for OwnedCreatePreparationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Effective(_) => "LAUNCH_EFFECTIVE",
            Self::Storage(e) => e.code(),
            Self::Observation(_) => "LAUNCH_OBSERVATION",
        })
    }
}
impl std::error::Error for OwnedCreatePreparationError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Effective(e) => Some(e),
            Self::Storage(e) => Some(e),
            Self::Observation(e) => Some(e),
        }
    }
}
impl StorageClaim {
    /// Original start intent check over THIS actual claim, not supplied paths.
    pub(in crate::installing_broker) fn require_launch_start_allowed(
        &self,
        source: &reverie_contracts::worker_config::EffectiveWorkerConfig,
    ) -> Result<(), StorageWorkflowError> {
        let settings =
            reverie_contracts::resource_config::ResourceIdentitySettings::capture_worker_config(
                source,
            )
            .map_err(StorageOwnerError::Settings)?;
        let config =
            reverie_store::storage_identity::StorageIdentityConfig::capture_worker_settings(
                &settings,
            );
        let allowed = reverie_store::storage_identity::storage_start_allowed(&config, self.paths())
            .map_err(StorageOwnerError::Identity)?;
        if !allowed {
            return Err(StorageWorkflowError::refused(
                "Only the current employee session may start its laptop",
            ));
        }
        Ok(())
    }

    /// The original runtime.json and exit.exists observation over the SAME
    /// resource; retained/consumed registry variants cannot borrow raw paths.
    pub fn observe_launch_receipt(
        &self,
    ) -> Result<reverie_host::worker_storage::LaunchReceiptObservation, StorageWorkflowError> {
        match &self.state {
            ClaimState::Started(owner) => Ok(owner.borrow()?.observe_launch_receipt()?),
            ClaimState::Legacy { owner, .. } => Ok(owner.observe_launch_receipt()?),
            ClaimState::Registered {
                registry, identity, ..
            } => {
                let entries = registry.lock(registry.runtime.stop_deadline())?;
                let entry = entries
                    .iter()
                    .find(|entry| Arc::ptr_eq(&entry.identity, identity))
                    .ok_or_else(|| StorageWorkflowError::refused("WORKER_STORAGE_CLAIM_CHANGED"))?;
                if !entry.writer_checked {
                    return Err(StorageWorkflowError::refused(
                        "WORKER_STORAGE_CLEANUP_UNCONFIRMED",
                    ));
                }
                let EntryOwner::Direct(owner) = &entry.owner else {
                    return Err(StorageWorkflowError::refused("WORKER_NIX_STORAGE_RETAINED"));
                };
                Ok(owner.observe_launch_receipt()?)
            }
        }
    }
    /// Keep actual custody while resolving effective config exactly once and
    /// observing arguments. Refuse retained/consumed owners BEFORE any new
    /// native lookup. No employee lease or source/current setter is invented.
    pub fn prepare_create_plan(
        &self,
        captured: &ValidatedWorkerSnapshot,
    ) -> Result<ObservedCreatePlan, OwnedCreatePreparationError> {
        match &self.state {
            ClaimState::Started(owner) => {
                let borrowed = owner
                    .borrow()
                    .map_err(OwnedCreatePreparationError::Storage)?;
                let source = captured.configuration().clone();
                borrowed
                    .assert_binding(&source, borrowed.paths().session())
                    .map_err(StorageWorkflowError::from)
                    .map_err(OwnedCreatePreparationError::Storage)?;
                let effective =
                    resource_staging::effective_config(source.clone(), borrowed.paths().session())
                        .map_err(OwnedCreatePreparationError::Effective)?;
                borrowed
                    .prepare_create_plan(source, effective)
                    .map_err(|cause| match cause {
                        reverie_host::worker_laptop::LaptopError::Plan(cause) => {
                            OwnedCreatePreparationError::Observation(cause)
                        }
                        cause => OwnedCreatePreparationError::Storage(cause.into()),
                    })
            }
            ClaimState::Legacy { registry, owner } => observe(&registry.runtime, owner, captured),
            ClaimState::Registered {
                registry, identity, ..
            } => {
                let entries = registry
                    .lock(registry.runtime.stop_deadline())
                    .map_err(OwnedCreatePreparationError::Storage)?;
                let entry = entries
                    .iter()
                    .find(|entry| Arc::ptr_eq(&entry.identity, identity))
                    .ok_or_else(|| refused("WORKER_STORAGE_CLAIM_CHANGED"))?;
                if !entry.writer_checked {
                    return Err(refused("WORKER_STORAGE_CLEANUP_UNCONFIRMED"));
                }
                let EntryOwner::Direct(owner) = &entry.owner else {
                    return Err(refused("WORKER_NIX_STORAGE_RETAINED"));
                };
                observe(&registry.runtime, owner, captured)
            }
        }
    }
}
fn refused(code: &'static str) -> OwnedCreatePreparationError {
    OwnedCreatePreparationError::Storage(StorageWorkflowError::refused(code))
}
fn observe(
    runtime: &WorkerRuntime,
    owner: &LaunchStorage,
    captured: &ValidatedWorkerSnapshot,
) -> Result<ObservedCreatePlan, OwnedCreatePreparationError> {
    let source = captured.configuration().clone();
    let session = owner.paths().session();
    owner
        .assert_binding(runtime, &source, session)
        .map_err(|error| {
            OwnedCreatePreparationError::Observation(CreateObservationError::Owner(error))
        })?;
    let effective = resource_staging::effective_config(source.clone(), session)
        .map_err(OwnedCreatePreparationError::Effective)?;
    runtime
        .prepare_laptop_plan(source, effective, owner)
        .map_err(OwnedCreatePreparationError::Observation)
}
