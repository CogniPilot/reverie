//! Real bounded resource custody. InstallingBroker supplies its admitted
//! sequence; handles/data here never mint owner, admission or start authority.
mod cleanup;
mod drive;
mod log;
#[cfg(test)]
mod tests;
use super::*;
use crate::{
    installed_worker_engine::InstalledWorkerEngine, worker_runtime::WorkerRuntime,
    worker_storage::LaunchStorage,
};
use reverie_contracts::{storage_identity::MetadataText, worker_storage::StorageConfiguration};
use reverie_core::ids::ContainerId;
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NixDisposition {
    NoHelper,
    Prepared,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NixProgress {
    NoHelper,
    Prepared,
    Rejected,
    Retained,
}
struct Resources {
    guard: NixStoreGuard,
    storage: LaunchStorage,
}
#[derive(Clone, Copy, Eq, PartialEq)]
enum Phase {
    Held,
    Running,
    Known,
    Retained,
    Consumed,
}
#[derive(Clone, Copy)]
enum CleanupStage {
    NotSubmitted(Option<Instant>),
    Admitted,
    Expired,
}
struct Record {
    id: u64,
    resources: Option<Resources>,
    prepared: EffectiveWorkerConfig,
    phase: Phase,
    outcome: Option<Result<NixDisposition>>,
    turn: bool,
    unknown_effect: bool,
    pending_call: Option<crate::captured_client::CapturedCall>,
    helper: Option<ContainerId>,
    deadline: Option<Instant>,
    logs_stage: CleanupStage,
    removal_stage: CleanupStage,
    removal_confirmed: bool,
    last_settlement: Option<crate::engine_metadata::EngineError>,
    #[cfg(test)]
    before_remove: Option<Arc<crate::captured_client::test_hooks::Gate>>,
}
type RecordOwner = Arc<Mutex<Record>>;
type RecordListGuard<'a> = std::sync::MutexGuard<'a, Vec<RecordOwner>>;
impl Record {
    fn resources(&self) -> &Resources {
        self.resources.as_ref().expect("retained real resources")
    }
    fn resources_mut(&mut self) -> &mut Resources {
        self.resources.as_mut().expect("retained real resources")
    }
    fn progress(&self) -> NixProgress {
        if self.phase != Phase::Known {
            return NixProgress::Retained;
        }
        match self.outcome.as_ref().expect("known actual result") {
            Ok(NixDisposition::NoHelper) => NixProgress::NoHelper,
            Ok(NixDisposition::Prepared) => NixProgress::Prepared,
            Err(_) => NixProgress::Rejected,
        }
    }
    fn note(&mut self, error: NixError) {
        self.outcome = Some(match self.outcome.take() {
            Some(Err(primary)) => Err(NixError::Finalization {
                primary: Box::new(primary),
                secondary: Box::new(error),
            }),
            _ => Err(error),
        });
    }
}

/// Same live record identity, not a status-derived permission or resource
/// constructor. Cloning shares custody; the runtime retains it independently.
#[must_use = "retain the actual workflow until its resources are reclaimed"]
#[derive(Clone)]
pub struct NixWorkflow {
    origin: Arc<InstalledWorkerEngine>,
    record: RecordOwner,
    session: ProfileSessionId,
}
impl NixWorkflow {
    pub fn session(&self) -> &ProfileSessionId {
        &self.session
    }
    pub fn same_workflow(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.origin, &other.origin) && Arc::ptr_eq(&self.record, &other.record)
    }
}
#[must_use = "restore the original owners to the real registry"]
pub struct NixRetainFailure {
    resources: Resources,
    error: NixError,
}
impl NixRetainFailure {
    pub fn into_parts(self: Box<Self>) -> (NixStoreGuard, LaunchStorage, NixError) {
        (self.resources.guard, self.resources.storage, self.error)
    }
}
#[must_use = "unknown reclamation retains the real workflow handle"]
pub struct NixReclaimFailure {
    workflow: NixWorkflow,
    error: NixError,
}
impl NixReclaimFailure {
    pub fn into_parts(self) -> (NixWorkflow, NixError) {
        (self.workflow, self.error)
    }
}
#[must_use = "retain returned owners through the actual next lifecycle phase"]
pub struct NixReturned {
    resources: Resources,
    outcome: Result<NixDisposition>,
}
impl NixReturned {
    pub fn into_parts(self) -> (NixStoreGuard, LaunchStorage, Result<NixDisposition>) {
        (self.resources.guard, self.resources.storage, self.outcome)
    }
}

pub(crate) struct Workflows {
    maximum: usize,
    next: AtomicU64,
    turn: AtomicU64,
    records: Mutex<Vec<RecordOwner>>,
}
impl Workflows {
    pub(crate) fn new(maximum: usize) -> Self {
        Self {
            maximum,
            next: AtomicU64::new(1),
            turn: AtomicU64::new(0),
            records: Mutex::new(Vec::with_capacity(maximum)),
        }
    }
    fn retain(
        &self,
        runtime: &WorkerRuntime,
        resources: Resources,
        prepared: EffectiveWorkerConfig,
    ) -> std::result::Result<NixWorkflow, Box<NixRetainFailure>> {
        let result = self.insert(runtime, &resources, &prepared);
        let (id, mut records) = match result {
            Ok(result) => result,
            Err(error) => return Err(Box::new(NixRetainFailure { resources, error })),
        };
        let session = resources.guard.session().clone();
        let record = Arc::new(Mutex::new(Record {
            id,
            resources: Some(resources),
            prepared,
            phase: Phase::Held,
            outcome: None,
            turn: false,
            unknown_effect: false,
            pending_call: None,
            helper: None,
            deadline: None,
            logs_stage: CleanupStage::NotSubmitted(None),
            removal_stage: CleanupStage::NotSubmitted(None),
            removal_confirmed: false,
            last_settlement: None,
            #[cfg(test)]
            before_remove: None,
        }));
        records.push(record.clone());
        Ok(NixWorkflow {
            origin: runtime.installed_engine().clone(),
            record,
            session,
        })
    }
    fn insert<'a>(
        &'a self,
        runtime: &WorkerRuntime,
        resources: &Resources,
        prepared: &EffectiveWorkerConfig,
    ) -> Result<(u64, RecordListGuard<'a>)> {
        resources
            .storage
            .assert_binding(runtime, prepared, resources.guard.session())?;
        need(
            StorageConfiguration::capture(resources.guard.config.source())
                .matches_service_namespace(runtime.worker_identity()),
            NixFault::RuntimeBinding,
        )?;
        same_namespace(
            &resources.guard.config,
            &NixConfiguration::capture(prepared),
        )?;
        let records = self
            .records
            .try_lock()
            .map_err(|_| NixError::Refused(NixFault::Capacity))?;
        need(records.len() < self.maximum, NixFault::Capacity)?;
        let id = self
            .next
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |id| id.checked_add(1))
            .map_err(|_| NixError::Refused(NixFault::Capacity))?;
        Ok((id, records))
    }
    fn bound(&self, runtime: &WorkerRuntime, workflow: &NixWorkflow) -> Result<()> {
        need(
            Arc::ptr_eq(runtime.installed_engine(), &workflow.origin),
            NixFault::RuntimeBinding,
        )?;
        let records = self
            .records
            .try_lock()
            .map_err(|_| NixError::Refused(NixFault::Retained))?;
        need(
            records
                .iter()
                .any(|record| Arc::ptr_eq(record, &workflow.record)),
            NixFault::Replayed,
        )
    }
    fn run(&self, runtime: &WorkerRuntime, workflow: &NixWorkflow) -> Result<NixProgress> {
        self.bound(runtime, workflow)?;
        let mut record = workflow
            .record
            .try_lock()
            .map_err(|_| NixError::Refused(NixFault::Retained))?;
        need(record.phase == Phase::Held, NixFault::Replayed)?;
        record.phase = Phase::Running;
        record.outcome = Some(drive::execute(runtime, self, &mut record));
        cleanup::finish(runtime, self, &mut record, None);
        Ok(record.progress())
    }
    fn reclaim(&self, runtime: &WorkerRuntime, workflow: &NixWorkflow) -> Result<NixReturned> {
        self.bound(runtime, workflow)?;
        let mut records = self
            .records
            .try_lock()
            .map_err(|_| NixError::Refused(NixFault::Retained))?;
        let mut record = workflow
            .record
            .try_lock()
            .map_err(|_| NixError::Refused(NixFault::Retained))?;
        need(
            record.phase == Phase::Known && !record.turn,
            NixFault::Retained,
        )?;
        let resources = record.resources.take().expect("known unreclaimed owners");
        let outcome = record.outcome.take().expect("known actual outcome");
        record.phase = Phase::Consumed;
        records.retain(|entry| !Arc::ptr_eq(entry, &workflow.record));
        Ok(NixReturned { resources, outcome })
    }
    pub(crate) fn settle(&self, runtime: &WorkerRuntime, deadline: Instant) -> Result<()> {
        let records = self
            .records
            .try_lock()
            .map_err(|_| NixError::Refused(NixFault::Retained))?
            .clone();
        let mut result = Ok(());
        for record in records {
            result = finalized(result, self.settle_record(runtime, &record, deadline));
        }
        result
    }
    fn settle_record(
        &self,
        runtime: &WorkerRuntime,
        record: &RecordOwner,
        deadline: Instant,
    ) -> Result<()> {
        let mut record = record
            .try_lock()
            .map_err(|_| NixError::Refused(NixFault::Retained))?;
        if record.phase == Phase::Held && runtime.cancellation().is_cancelled() {
            record.outcome = Some(Err(NixError::Refused(NixFault::Cancelled)));
            record.phase = Phase::Known;
        }
        if record.phase == Phase::Retained {
            cleanup::finish(runtime, self, &mut record, Some(deadline));
        }
        if !matches!(record.phase, Phase::Held | Phase::Known | Phase::Consumed) {
            return Err(record
                .last_settlement
                .clone()
                .map(NixError::Engine)
                .unwrap_or(NixError::Refused(NixFault::Retained)));
        }
        Ok(())
    }
    fn release_turn(&self, record: &mut Record) -> Result<()> {
        if record.turn {
            self.turn
                .compare_exchange(record.id, 0, Ordering::AcqRel, Ordering::Acquire)
                .map_err(|_| NixError::Refused(NixFault::Retained))?;
            record.turn = false;
        }
        Ok(())
    }
}
impl WorkerRuntime {
    /// Pure binding + bounded resource retention only: call while the actual
    /// registry owns its lock, then run the returned record outside that lock.
    pub fn retain_nix_store(
        &self,
        guard: NixStoreGuard,
        storage: LaunchStorage,
        prepared: EffectiveWorkerConfig,
    ) -> std::result::Result<NixWorkflow, Box<NixRetainFailure>> {
        self.nix_workflows()
            .retain(self, Resources { guard, storage }, prepared)
    }
    pub fn run_nix_store(&self, workflow: &NixWorkflow) -> Result<NixProgress> {
        self.nix_workflows().run(self, workflow)
    }
    pub fn reclaim_nix_store(
        &self,
        workflow: NixWorkflow,
    ) -> std::result::Result<NixReturned, NixReclaimFailure> {
        self.nix_workflows()
            .reclaim(self, &workflow)
            .map_err(|error| NixReclaimFailure { workflow, error })
    }
}
