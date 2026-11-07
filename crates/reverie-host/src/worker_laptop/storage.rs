//! Purpose-closed borrowing of the actual Started resource. This retains the
//! same record and never exposes a raw storage reference or mutable callback.
use super::*;
use crate::{
    worker_reports::WorkerLaunchConnection,
    worker_storage::{LaunchReceiptObservation, LaunchStorage, StorageOwnershipKind},
};
use reverie_contracts::worker_config::EffectiveWorkerConfig;
use reverie_core::ids::ProfileSessionId;
use reverie_store::storage_identity::StoragePaths;
use std::sync::MutexGuard;

pub struct StartedStorageBorrow<'a> {
    runtime: &'a WorkerRuntime,
    record: MutexGuard<'a, Record>,
}
impl StartedStorageBorrow<'_> {
    fn storage(&self) -> &LaunchStorage {
        self.record.resources().storage()
    }
    fn storage_mut(&mut self) -> &mut LaunchStorage {
        self.record
            .resources
            .as_mut()
            .expect("actual Started owner")
            .nix
            .storage_mut()
    }
    pub fn paths(&self) -> &StoragePaths {
        self.storage().paths()
    }
    pub fn ownership_kind(&self) -> StorageOwnershipKind {
        self.storage().ownership_kind()
    }
    pub fn assert_binding(
        &self,
        source: &EffectiveWorkerConfig,
        session: &ProfileSessionId,
    ) -> Result<()> {
        self.storage()
            .assert_binding(self.runtime, source, session)
            .map_err(LaptopError::StorageOwner)
    }
    pub fn check_resource_current(&self) -> Result<StorageOwnershipKind> {
        self.storage()
            .check_resource_current()
            .map_err(LaptopError::StorageOwner)
    }
    pub fn require_no_cold_pending(&self) -> Result<()> {
        self.storage()
            .require_no_cold_pending()
            .map_err(LaptopError::StorageOwner)
    }
    pub fn prepare_cold_launch_storage(&mut self) -> Result<()> {
        self.storage_mut()
            .prepare_cold_launch_storage()
            .map_err(LaptopError::StorageOwner)
    }
    pub fn prepare_runtime_directory(&mut self) -> Result<()> {
        self.storage_mut()
            .prepare_runtime_directory()
            .map_err(LaptopError::StorageOwner)
    }
    pub fn observe_launch_receipt(&self) -> Result<LaunchReceiptObservation> {
        self.storage()
            .observe_launch_receipt()
            .map_err(LaptopError::StorageOwner)
    }
    pub fn record_storage_binding(&mut self) -> Result<()> {
        self.storage_mut()
            .record_storage_binding()
            .map_err(LaptopError::StorageOwner)
    }
    pub fn prepare_create_plan(
        &self,
        source: EffectiveWorkerConfig,
        effective: EffectiveWorkerConfig,
    ) -> Result<ObservedCreatePlan> {
        self.runtime
            .prepare_laptop_plan(source, effective, self.storage())
            .map_err(LaptopError::Plan)
    }
    pub fn check_storage_writers_for_worker(&self) -> Result<()> {
        self.runtime
            .check_storage_writers(self.storage(), None)
            .map_err(LaptopError::StorageOwner)
    }
}
impl WorkerRuntime {
    /// A later real J must follow the actual predecessor's physical socket
    /// close and explicit logical Hold release. No can_progress=false shortcut.
    pub fn borrow_started_laptop_storage<'a>(
        &'a self,
        created: &'a CreatedLaptop,
        connection: &WorkerLaunchConnection,
    ) -> Result<StartedStorageBorrow<'a>> {
        let record = self
            .laptop_workflows()
            .started_storage_record(self, created)?;
        let resources = record.resources();
        let next = connection
            .viewer_constructor_identity(self, resources.plan.session())
            .map_err(LaptopError::Refused)?;
        let original = resources
            .connection
            .as_ref()
            .ok_or(LaptopError::Refused("WORKER_STARTED_CONNECTION_REQUIRED"))?;
        need(
            !original.same(&next) || record.phase == Phase::Known,
            "WORKER_STARTED_FORWARD_CLOSED",
        )?;
        if !original.same(&next) {
            original
                .require_released_predecessor(&next)
                .map_err(LaptopError::Refused)?;
            require_local_closed(self, &record)?;
        }
        Ok(StartedStorageBorrow {
            runtime: self,
            record,
        })
    }
    /// Read/prepare purposes for an actual protected source owner. No ordinary
    /// J is fabricated. App still supplies its genuine entered source scope.
    pub fn borrow_started_laptop_source_storage<'a>(
        &'a self,
        created: &'a CreatedLaptop,
    ) -> Result<StartedStorageBorrow<'a>> {
        let record = self
            .laptop_workflows()
            .started_storage_record(self, created)?;
        record
            .resources()
            .connection
            .as_ref()
            .ok_or(LaptopError::Refused("WORKER_STARTED_CONNECTION_REQUIRED"))?
            .require_released()
            .map_err(LaptopError::Refused)?;
        require_local_closed(self, &record)?;
        Ok(StartedStorageBorrow {
            runtime: self,
            record,
        })
    }
}
fn require_local_closed(runtime: &WorkerRuntime, record: &Record) -> Result<()> {
    need(
        record.resources().nix.guard_close_confirmed(),
        "WORKER_STARTED_NIX_GUARD_RETAINED",
    )?;
    storage_cleanup::require_viewer_closed(runtime, record)?;
    if let Some(publication) = record
        .creation
        .as_ref()
        .and_then(|creation| creation.publication.as_ref())
    {
        publication.require_native_closed()?;
    }
    Ok(())
}
impl Workflows {
    pub(super) fn started_storage_record<'a>(
        &self,
        runtime: &WorkerRuntime,
        created: &'a CreatedLaptop,
    ) -> Result<MutexGuard<'a, Record>> {
        self.bound(runtime, &created.workflow)?;
        let record = created
            .workflow
            .record
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_RETAINED"))?;
        need(
            matches!(record.phase, Phase::Known | Phase::Cleaning)
                && record.pending.is_none()
                && record.finalization.available_for_started_owner()
                && !record.unknown
                && record.cleanup.is_none()
                && record
                    .outcome
                    .as_ref()
                    .is_some_and(|outcome| outcome.is_ok())
                && record.creation.as_ref().is_some_and(|creation| {
                    matches!(
                        creation.stage,
                        create::CreateStage::NixGuardReleased | create::CreateStage::Viewing
                    )
                }),
            "WORKER_STARTED_STORAGE_PHASE",
        )?;
        Ok(record)
    }
}
