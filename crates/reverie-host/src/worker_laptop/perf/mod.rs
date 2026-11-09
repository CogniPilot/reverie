//! One-shot fixed guest perf check within the actual post-memory Cold phase.
//! Completion is not protected admission, physical pool membership or CLI ACK.
use super::call_budget::CallBudget;
use super::*;
use reverie_contracts::{
    task_perf_check::{CHECKER, PerfCheckData},
    task_perf_v1::projected_selection,
};
use reverie_core::{operations::JournalId, task_perf::TaskPerfPolicy};
mod facts;
mod state;
pub(in crate::worker_laptop) use state::{Attempt, close_abandoned};

pub(super) fn check(
    runtime: &WorkerRuntime,
    record: &mut Record,
    supplied: CallBudget,
) -> Result<()> {
    let selection = projected_selection(record.resources().plan.effective_configuration())
        .map_err(LaptopError::PerfData)?;
    if selection != Some(TaskPerfPolicy::TaskV2) {
        return Ok(());
    }
    need(
        record
            .creation
            .as_ref()
            .is_some_and(|creation| creation.worker_perf.is_none())
            && !record.unknown
            && record.pending.is_none(),
        "TASK_PERF_REPLAYED_OR_UNCONFIRMED",
    )?;
    // One aggregate window, never renewed by inspect, hash, exec or cleanup.
    let budget = CallBudget::bounded(supplied.end(runtime, 20));
    let end = budget.end(runtime, 20);
    let installed = crate::task_perf::capsule::InstalledCapsule::observe(runtime, end)
        .map_err(capsule_error)?;
    record
        .creation
        .as_mut()
        .expect("actual memory-configured creation")
        .worker_perf = Some(Attempt::unopened(installed));
    let body = run(runtime, record, budget);
    let close = close_abandoned(record);
    if body.is_ok() && close.is_ok() && record.pending.is_none() {
        // This clears only this attempt's in-flight exec marker after actual
        // zero exit, verified static checker result, all joins and checked closes.
        // A client/daemon uncertainty returned Err and can never reach this arm.
        record.unknown = false;
    }
    finalized(body, close)
}
fn run(runtime: &WorkerRuntime, record: &mut Record, budget: CallBudget) -> Result<()> {
    let before = facts::Facts::observe(runtime, record, budget)?;
    state::get_mut(record).pin(before.pid)?;
    before.same(&facts::Facts::observe(runtime, record, budget)?)?;
    state::get(record).live()?;
    state::get_mut(record)
        .files
        .open(runtime, before.pid, budget.end(runtime, 20))
        .map_err(capsule_error)?;
    let nonce = nonce()?;
    execute(runtime, record, budget, &nonce)?;
    state::get(record).live()?;
    state::get(record)
        .files
        .reobserve(runtime, before.pid, budget.end(runtime, 20))
        .map_err(capsule_error)?;
    before.same(&facts::Facts::observe(runtime, record, budget)?)?;
    state::get(record).live()?;
    facts::current(runtime, record, budget)
}
fn execute(
    runtime: &WorkerRuntime,
    record: &mut Record,
    budget: CallBudget,
    nonce: &JournalId,
) -> Result<()> {
    facts::current(runtime, record, budget)?;
    let cid = record
        .creation
        .as_ref()
        .and_then(|creation| creation.container.as_ref())
        .expect("strict actual CID");
    // Config.User was checked against this same captured source by Facts.
    // Docker inherits that user; no root/privileged/user override is accepted.
    let args = vec![
        "exec".into(),
        "--workdir".into(),
        "/tmp".into(),
        cid.as_str().into(),
        CHECKER.into(),
        "--nonce".into(),
        nonce.as_str().into(),
    ];
    // A daemon exec may outlive a failed/lost CLI acknowledgement. Retain that
    // uncertainty until this SAME whole attempt proves completion above.
    record.unknown = true;
    let output =
        network::call_with_budget(runtime, record, args, network::CallPurpose::Launch, budget)?;
    need(output.succeeded, "TASK_PERF_GUEST_CHECK_FAILED")?;
    let result = PerfCheckData::decode(&output.stdout).map_err(LaptopError::PerfResult)?;
    let uid =
        reverie_contracts::worker_launch::LaunchSettings::capture(record.resources().plan.source())
            .map_err(LaptopError::Data)?
            .uid();
    need(
        result.nonce() == nonce && result.uid() == uid,
        "TASK_PERF_GUEST_RESULT_CHANGED",
    )
}
fn nonce() -> Result<JournalId> {
    let mut bytes = [0; 16];
    getrandom::getrandom(&mut bytes).map_err(|_| LaptopError::Refused("TASK_PERF_NONCE"))?;
    let value = reverie_core::ids::NativeOperationId::from_random_bytes(bytes);
    JournalId::parse(value.as_str()).map_err(|_| LaptopError::Refused("TASK_PERF_NONCE"))
}
fn capsule_error(error: crate::task_perf::capsule::CapsuleError) -> LaptopError {
    LaptopError::PerfCapsule(crate::task_perf::PerfCapsuleFailure::new(error))
}
