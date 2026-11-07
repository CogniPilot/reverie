//! Already-stopped protected sources need no fabricated stop call/token. The
//! private App claim still owns authorization; this is checked custody return.
use super::*;
pub struct StartedSourceStorageObservation {
    attachment: Arc<()>,
    observation: CreatedStorageObservation,
}
impl StartedSourceStorageObservation {
    pub fn is_live(&self) -> bool {
        self.observation.is_live()
    }
    pub fn same_source(&self, source: &StartedLaptopSource) -> bool {
        Arc::ptr_eq(&self.attachment, &source.current)
            && self.observation.same_workflow(&source.workflow)
    }
}
/// Default Drop leaves the original resources in the same counted Source slot.
#[must_use = "consume only inside the actual protected SourceRecord transaction"]
pub struct StoppedStartedSourceReturned<'a> {
    inner: StoppedCreatedReturned<'a>,
}
impl StoppedStartedSourceReturned<'_> {
    pub fn into_parts(
        self,
    ) -> (
        Box<crate::worker_storage::LaunchStorage>,
        ObservedCreatePlan,
        WorkerRequest,
        OfficePhone,
        Option<Arc<LaptopError>>,
    ) {
        self.inner.into_parts()
    }
}
impl WorkerRuntime {
    pub fn observe_started_source_final_storage(
        &self,
        source: &StartedLaptopSource,
    ) -> Result<StartedSourceStorageObservation> {
        let mut record = self.laptop_workflows().source_record(self, source)?;
        need(
            matches!(record.phase, Phase::Known | Phase::Cleaning)
                && record.finalization.untouched()
                && record.pending.is_none(),
            "WORKER_STARTED_SOURCE_FINAL_STORAGE_PHASE",
        )?;
        record.phase = Phase::Cleaning;
        let observation =
            created_finalization::observe_closed(self, &mut record, &source.workflow)?;
        Ok(StartedSourceStorageObservation {
            attachment: source.current.clone(),
            observation,
        })
    }
    /// A stamped false result does not suffice: this same Source must still
    /// own checked-closed guard, viewer, publication and joined Office resources.
    pub fn prepare_stopped_started_source_return<'a>(
        &'a self,
        source: &'a StartedLaptopSource,
        observation: &StartedSourceStorageObservation,
    ) -> Result<StoppedStartedSourceReturned<'a>> {
        let record = self.laptop_workflows().source_record(self, source)?;
        need(
            observation.same_source(source),
            "WORKER_STARTED_SOURCE_OBSERVATION_CHANGED",
        )?;
        need(
            record.phase == Phase::Cleaning
                && record.pending.is_none()
                && !record.unknown
                && record.cleanup.is_none(),
            "WORKER_STARTED_SOURCE_RETURN_UNCONFIRMED",
        )?;
        record
            .finalization
            .require_stopped(&source.workflow, &observation.observation)?;
        created_finalization::require_native_closed(self, &record)?;
        let inventory = self
            .laptop_workflows()
            .records
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_RETAINED"))?;
        need(
            inventory
                .iter()
                .any(|entry| entry.is_source(&source.workflow.record)),
            "WORKER_STARTED_SOURCE_CONSUMED",
        )?;
        Ok(StoppedStartedSourceReturned {
            inner: StoppedCreatedReturned::source(inventory, record, &source.workflow.record),
        })
    }
}
