//! Fixed NEW-created CID cleanup, distinct from protected OLD-source stop.
//! By-name success without a canonical CID stays retained for reconciliation.
use super::*;
use reverie_contracts::worker_launch::CreatedState;
use reverie_core::ids::ContainerId;
pub(super) struct Cleanup {
    budget: call_budget::CallBudget,
    error: Option<Arc<LaptopError>>,
}
#[must_use = "local stopped phase retains real Office/storage/request owners"]
pub struct StoppedCreatedLaptop {
    pub(super) workflow: LaptopWorkflow,
}
impl StoppedCreatedLaptop {
    pub fn same_workflow(&self, other: &LaptopWorkflow) -> bool {
        self.workflow.same_workflow(other)
    }
}
#[must_use = "retain actual workflow on uncertain provider cleanup"]
pub enum CreatedCleanup {
    Stopped(StoppedCreatedLaptop),
    Retained,
}
impl Workflows {
    fn cleanup_created(
        &self,
        runtime: &WorkerRuntime,
        created: &CreatedLaptop,
        budget: call_budget::CallBudget,
    ) -> Result<CreatedCleanup> {
        self.bound(runtime, &created.workflow)?;
        let mut record = created
            .workflow
            .record
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_RETAINED"))?;
        need(
            record
                .creation
                .as_ref()
                .is_some_and(create::Creation::owns_created),
            "WORKER_LAPTOP_CREATED_OWNER_REQUIRED",
        )?;
        if record.cleanup.is_some() {
            return Ok(if record.phase == Phase::Stopped {
                CreatedCleanup::Stopped(StoppedCreatedLaptop {
                    workflow: created.workflow.clone(),
                })
            } else {
                CreatedCleanup::Retained
            });
        }
        // Terminal lifecycle transition under this SAME record mutex, before
        // any constructor settlement or cleanup effect. All forward methods
        // require their original Known/Held state and cannot restart it.
        record.phase = Phase::Cleaning;
        record.cleanup = Some(Cleanup {
            budget,
            error: None,
        });
        let Some(cid) = record.creation.as_ref().expect("created").container.clone() else {
            let error = Arc::new(LaptopError::Refused(
                "WORKER_LAPTOP_CREATED_CID_RECONCILIATION_REQUIRED",
            ));
            record.cleanup.as_mut().expect("cleanup").error = Some(error.clone());
            record.phase = Phase::CleanupRetained;
            return Err(LaptopError::Recorded(error));
        };
        let memory = memory::close_abandoned(&mut record);
        let result = finalized(memory, run(runtime, &mut record, &cid));
        let result =
            result.and_then(|()| need(!record.unknown, "WORKER_LAPTOP_PRIOR_EFFECT_UNCONFIRMED"));
        if let Err(error) = result {
            record.cleanup.as_mut().expect("registered cleanup").error = Some(Arc::new(error));
            record.phase = Phase::CleanupRetained;
            return Ok(CreatedCleanup::Retained);
        }
        record.phase = Phase::Stopped;
        // Deliberately no reclamation/global ACK: actual Nix/storage, Office
        // requests and native owners still belong here.
        Ok(CreatedCleanup::Stopped(StoppedCreatedLaptop {
            workflow: created.workflow.clone(),
        }))
    }
}
fn run(runtime: &WorkerRuntime, record: &mut Record, cid: &ContainerId) -> Result<()> {
    let budget = record.cleanup.as_ref().expect("cleanup owner").budget;
    let resources = record.resources();
    resources
        .storage()
        .assert_binding(runtime, resources.plan.source(), resources.plan.session())
        .map_err(|error| LaptopError::Nix(crate::worker_nix::NixError::Owner(error)))?;
    if let Some(call) = &record.pending {
        runtime
            .installed_engine()
            .engine
            .client
            .settle_call(call, budget.settlement_end(runtime))
            .map_err(|error| LaptopError::Engine(error.into()))?;
        record.pending = None;
    }
    let _optional_stop = network::call_with_budget(
        runtime,
        record,
        vec![
            "stop".into(),
            "--time".into(),
            "2".into(),
            cid.as_str().into(),
        ],
        network::CallPurpose::Cleanup,
        budget,
    )?;
    let state = inspect(runtime, record, cid, budget)?;
    if state.running() {
        let result = network::call_with_budget(
            runtime,
            record,
            vec!["kill".into(), cid.as_str().into()],
            network::CallPurpose::Cleanup,
            budget,
        )?;
        need(result.succeeded, "WORKER_LAPTOP_CREATED_KILL_UNCONFIRMED")?;
        need(
            inspect(runtime, record, cid, budget)?.stopped(),
            "WORKER_LAPTOP_CREATED_STOP_UNCONFIRMED",
        )?;
    } else {
        need(state.stopped(), "WORKER_LAPTOP_CREATED_STOP_UNCONFIRMED")?;
    }
    Ok(())
}
fn inspect(
    runtime: &WorkerRuntime,
    record: &mut Record,
    cid: &ContainerId,
    budget: call_budget::CallBudget,
) -> Result<CreatedState> {
    let output = network::call_with_budget(
        runtime,
        record,
        vec!["inspect".into(), cid.as_str().into()],
        network::CallPurpose::Observe,
        budget,
    )?;
    need(
        output.succeeded,
        "WORKER_LAPTOP_CREATED_INSPECTION_UNCONFIRMED",
    )?;
    CreatedState::decode(&output.stdout, cid).map_err(LaptopError::CreatedState)
}
impl WorkerRuntime {
    /// Stop only this actual created immutable CID; never a recycled name or
    /// caller-supplied identity. Failure/unknown leaves the full record owned.
    pub fn stop_created_laptop(
        &self,
        created: &CreatedLaptop,
        deadline: Instant,
    ) -> Result<CreatedCleanup> {
        self.laptop_workflows().cleanup_created(
            self,
            created,
            call_budget::CallBudget::bounded(deadline),
        )
    }
    /// Same original actual J, even after its socket closes. No aggregate
    /// worker stop cap or forward-can_progress requirement is introduced.
    pub fn stop_created_laptop_for_worker(
        &self,
        created: &CreatedLaptop,
        connection: &crate::worker_reports::WorkerLaunchConnection,
    ) -> Result<CreatedCleanup> {
        self.laptop_workflows().assert_worker_cleanup_connection(
            self,
            &created.workflow,
            connection,
        )?;
        self.laptop_workflows()
            .cleanup_created(self, created, call_budget::CallBudget::worker())
    }
}

impl CreatedLaptop {
    /// Retained cleanup diagnostics, separate from the original body failure.
    pub fn cleanup_failure(&self) -> Result<Option<Arc<LaptopError>>> {
        let record = self
            .workflow
            .record
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_RETAINED"))?;
        Ok(record
            .cleanup
            .as_ref()
            .and_then(|cleanup| cleanup.error.clone()))
    }
}
