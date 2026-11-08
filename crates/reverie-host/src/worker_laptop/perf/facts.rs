use super::*;
use crate::reservation_kernel::ReservationKernel;
use reverie_contracts::{
    reservation_engine::ObservedMemoryPolicy,
    worker_cold_tmp::RetainedInspection,
    worker_recovery::{RecoveryInspection, RecoveryInspectionNeed},
};
pub(super) struct Facts {
    pub(super) pid: u32,
    identity: RetainedInspection,
    recovery: RecoveryInspection,
    start: String,
}
impl Facts {
    pub(super) fn observe(
        runtime: &WorkerRuntime,
        record: &mut Record,
        budget: CallBudget,
    ) -> Result<Self> {
        current(runtime, record, budget)?;
        let cid = record
            .creation
            .as_ref()
            .and_then(|creation| creation.container.clone())
            .ok_or(LaptopError::Refused("TASK_PERF_CREATED_CID_REQUIRED"))?;
        let output = network::call_with_budget(
            runtime,
            record,
            vec!["inspect".into(), cid.as_str().into()],
            network::CallPurpose::Observe,
            budget,
        )?;
        need(output.succeeded, "TASK_PERF_INSPECTION_FAILED")?;
        let resources = record.resources();
        let identity = RetainedInspection::decode_started(
            &output.stdout,
            &cid,
            resources.plan.source(),
            resources.plan.effective_configuration(),
            resources.plan.session(),
            resources
                .storage()
                .paths()
                .employee()
                .map(|_| resources.storage().paths().identity()),
        )
        .map_err(cold_data)?;
        let actual = identity.perf_profile().map_err(cold_data)?;
        let expected =
            crate::task_perf::observe_installed_task_perf_for_policy(TaskPerfPolicy::TaskV2)
                .map_err(LaptopError::PerfPolicy)?;
        need(
            actual.equivalent(expected.data().selected()),
            "TASK_PERF_ACTUAL_POLICY_CHANGED",
        )?;
        let text = std::str::from_utf8(&output.stdout)
            .map_err(|_| LaptopError::Refused("TASK_PERF_INSPECTION_ENCODING"))?;
        let RecoveryInspectionNeed::Present(recovery) =
            RecoveryInspection::inspect_data(resources.plan.arguments().name(), text, "", 0)
                .map_err(LaptopError::MemoryIdentity)?
        else {
            return Err(LaptopError::Refused("TASK_PERF_CONTAINER_ABSENT"));
        };
        let pid = recovery
            .started_memory_pid(
                resources.plan.arguments().name(),
                runtime.worker_identity().deployment(),
                resources.plan.session(),
                &cid,
                resources.plan.arguments().policy_digest(),
            )
            .map_err(LaptopError::MemoryIdentity)?;
        need(
            identity.pid().as_str() == pid.to_string(),
            "TASK_PERF_INIT_CHANGED",
        )?;
        let kernel = ReservationKernel::new();
        let policy = ObservedMemoryPolicy::from_effective(resources.plan.effective_configuration())
            .map_err(LaptopError::MemoryData)?;
        kernel
            .verify_recovery_limits(&recovery, policy.as_ref(), budget.end(runtime, 20))
            .map_err(LaptopError::MemoryKernel)?;
        let start = crate::reservation_kernel::existing_process_start(
            identity.pid(),
            budget.end(runtime, 20),
        )
        .map_err(LaptopError::MemoryKernel)?;
        current(runtime, record, budget)?;
        Ok(Self {
            pid,
            identity,
            recovery,
            start,
        })
    }
    pub(super) fn same(&self, other: &Self) -> Result<()> {
        need(
            self.pid == other.pid
                && self.start == other.start
                && self.recovery.same_memory_observation(&other.recovery)
                && self
                    .identity
                    .same_observation(&other.identity)
                    .map_err(cold_data)?,
            "TASK_PERF_INCARNATION_CHANGED",
        )
    }
}
fn cold_data(error: reverie_contracts::worker_cold_tmp::ColdDataError) -> LaptopError {
    LaptopError::ColdStorage(crate::worker_storage::StorageOwnerError::ColdData(error))
}
pub(super) fn current(runtime: &WorkerRuntime, record: &Record, budget: CallBudget) -> Result<()> {
    super::super::cold::running_budget(runtime, budget)?;
    need(
        create::start_allowed(record)?,
        "TASK_PERF_RUNNING_INTENT_CHANGED",
    )
}
