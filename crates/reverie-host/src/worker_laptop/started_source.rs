//! Source attachment is custody BEFORE the durable claim, not a stop grant.
//! It replaces the same slot so old Created aliases are fenced immediately.
use super::*;
use crate::{worker_source_stop::OriginalSourceStop, worker_storage::StorageOwnershipKind};
use reverie_contracts::{worker_config::EffectiveWorkerConfig, worker_source_stop::SourceStopName};
use reverie_core::ids::ProfileSessionId;
use reverie_store::storage_identity::StoragePaths;
use std::sync::MutexGuard;

#[must_use = "retain this actual counted source through claim/stop/known return"]
pub struct StartedLaptopSource {
    workflow: LaptopWorkflow,
    current: Arc<()>,
}
impl StartedLaptopSource {
    pub fn same_workflow(&self, other: &LaptopWorkflow) -> bool {
        self.workflow.same_workflow(other)
    }
}
pub struct StartedSourceStorageBorrow<'a> {
    runtime: &'a WorkerRuntime,
    record: MutexGuard<'a, Record>,
}
impl StartedSourceStorageBorrow<'_> {
    pub fn paths(&self) -> &StoragePaths {
        self.record.resources().storage().paths()
    }
    pub fn ownership_kind(&self) -> StorageOwnershipKind {
        self.record.resources().storage().ownership_kind()
    }
    pub fn assert_binding(
        &self,
        config: &EffectiveWorkerConfig,
        session: &ProfileSessionId,
    ) -> Result<()> {
        self.record
            .resources()
            .storage()
            .assert_binding(self.runtime, config, session)
            .map_err(LaptopError::StorageOwner)
    }
    pub fn check_resource_current(&self) -> Result<StorageOwnershipKind> {
        self.record
            .resources()
            .storage()
            .check_resource_current()
            .map_err(LaptopError::StorageOwner)
    }
}
#[must_use = "retain the protected source stop and original Office"]
pub struct StartedSourceStopTransferred {
    stop: OriginalSourceStop,
    office: OfficePhone,
    request: WorkerRequest,
}
impl StartedSourceStopTransferred {
    pub fn into_parts(self) -> (OriginalSourceStop, OfficePhone, WorkerRequest) {
        (self.stop, self.office, self.request)
    }
}
impl WorkerRuntime {
    /// App must retain this actual owner in its SourceRecord BEFORE journal
    /// publication/admission close. No EnteredResourceDraft is fabricated here.
    pub fn retain_started_laptop_source(
        &self,
        created: &CreatedLaptop,
    ) -> Result<StartedLaptopSource> {
        let workflows = self.laptop_workflows();
        let mut record = workflows.started_storage_record(self, created)?;
        let resources = record.resources();
        resources
            .connection
            .as_ref()
            .ok_or(LaptopError::Refused("WORKER_STARTED_CONNECTION_REQUIRED"))?
            .require_released()
            .map_err(LaptopError::Refused)?;
        started_transfer::require_closed(self, &record, &resources.plan)?;
        let mut inventory = workflows
            .records
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_RETAINED"))?;
        let slot = inventory
            .iter_mut()
            .find(|entry| entry.is_created(&created.workflow.record))
            .ok_or(LaptopError::Refused("WORKER_LAPTOP_REPLAYED"))?;
        let current = Arc::new(());
        record.source_attachment = Some(current.clone());
        *slot = RetainedRecord::Source(created.workflow.record.clone());
        Ok(StartedLaptopSource {
            workflow: created.workflow.clone(),
            current,
        })
    }
    pub fn borrow_started_source_storage<'a>(
        &'a self,
        source: &'a StartedLaptopSource,
    ) -> Result<StartedSourceStorageBorrow<'a>> {
        let record = self.laptop_workflows().source_record(self, source)?;
        Ok(StartedSourceStorageBorrow {
            runtime: self,
            record,
        })
    }
    /// Only the original unclaimed-attachment branch may restore this under
    /// its App registry transaction. No native effect/descriptor release occurs.
    pub fn restore_unclaimed_started_source(&self, source: &StartedLaptopSource) -> Result<()> {
        let mut record = self.laptop_workflows().source_record(self, source)?;
        let mut inventory = self
            .laptop_workflows()
            .records
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_RETAINED"))?;
        let slot = inventory
            .iter_mut()
            .find(|entry| entry.is_source(&source.workflow.record))
            .ok_or(LaptopError::Refused("WORKER_STARTED_SOURCE_CONSUMED"))?;
        record.source_attachment = None;
        *slot = RetainedRecord::Created(source.workflow.record.clone());
        Ok(())
    }
    /// Only now does App supply its actual retained claim's SourceStopName.
    /// The same resource moves directly into the existing protected stop owner.
    pub fn transfer_started_source_stop(
        &self,
        source: &StartedLaptopSource,
        name: SourceStopName,
        current: &EffectiveWorkerConfig,
        end: Option<Instant>,
    ) -> Result<StartedSourceStopTransferred> {
        let mut record = self.laptop_workflows().source_record(self, source)?;
        let mut inventory = self
            .laptop_workflows()
            .records
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_RETAINED"))?;
        let resources = record.resources();
        started_transfer::require_closed(self, &record, &resources.plan)?;
        started_transfer::require_identity(&record, Some(name.container()))?;
        need(
            name.name().as_str() == resources.plan.arguments().name(),
            "WORKER_STARTED_IDENTITY_CHANGED",
        )?;
        resources
            .storage()
            .assert_binding(self, current, name.session())
            .map_err(LaptopError::StorageOwner)?;
        let (storage, rest) =
            started_transfer::split(record.resources.take().expect("same source resource"));
        match self.retain_original_source_stop(storage, name, current, end) {
            Ok(stop) => {
                record.phase = Phase::Consumed;
                record.source_attachment = None;
                inventory.retain(|entry| !entry.is_source(&source.workflow.record));
                let (office, request) = rest.into_phone_request();
                Ok(StartedSourceStopTransferred {
                    stop,
                    office,
                    request,
                })
            }
            Err(failure) => {
                let (storage, error) = failure.into_parts();
                record.resources = Some(started_transfer::restore(*storage, rest));
                Err(LaptopError::OrdinaryStop(error))
            }
        }
    }
}
impl Workflows {
    fn source_record<'a>(
        &self,
        runtime: &WorkerRuntime,
        source: &'a StartedLaptopSource,
    ) -> Result<MutexGuard<'a, Record>> {
        need(
            Arc::ptr_eq(runtime.installed_engine(), &source.workflow.origin),
            "WORKER_LAPTOP_RUNTIME_CHANGED",
        )?;
        let inventory = self
            .records
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_RETAINED"))?;
        need(
            inventory
                .iter()
                .any(|entry| entry.is_source(&source.workflow.record)),
            "WORKER_STARTED_SOURCE_CONSUMED",
        )?;
        let record = source
            .workflow
            .record
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_RETAINED"))?;
        need(
            record.resources.is_some()
                && record
                    .source_attachment
                    .as_ref()
                    .is_some_and(|current| Arc::ptr_eq(current, &source.current)),
            "WORKER_STARTED_SOURCE_CONSUMED",
        )?;
        Ok(record)
    }
}
