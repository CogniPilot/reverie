use super::*;
use crate::captured_client::CapturedOutput;
use drive::{Query, Submission};

/// Only cleanup continues after an unknown result; create/start are never
/// replayed. Unknown identity or removal keeps both real owners/global turn.
pub(super) fn finish(
    runtime: &WorkerRuntime,
    workflows: &Workflows,
    record: &mut Record,
    ceiling: Option<Instant>,
) {
    if !settled_client(runtime, record, ceiling) {
        record.phase = Phase::Retained;
        return;
    }
    if let Some(id) = record.helper.clone() {
        logs(runtime, record, &id, ceiling);
        if matches!(record.logs_stage, CleanupStage::NotSubmitted(_))
            || !settled_client(runtime, record, ceiling)
        {
            record.phase = Phase::Retained;
            return;
        }
        #[cfg(test)]
        if let Some(gate) = record.before_remove.take() {
            gate.entered.store(true, Ordering::Release);
            while !gate.released.load(Ordering::Acquire) {
                std::thread::sleep(Duration::from_millis(1));
            }
        }
        remove(runtime, record, &id, ceiling);
    }
    if !settled_client(runtime, record, ceiling)
        || record.unknown_effect
        || (record.helper.is_some() && !record.removal_confirmed)
    {
        record.phase = Phase::Retained;
        return;
    }
    if let Err(error) = workflows.release_turn(record) {
        record.unknown_effect = true;
        record.note(error);
        record.phase = Phase::Retained;
        return;
    }
    record.phase = Phase::Known;
}
fn logs(runtime: &WorkerRuntime, record: &mut Record, id: &ContainerId, ceiling: Option<Instant>) {
    let mut stage = record.logs_stage;
    let result = cleanup_call(runtime, record, Query::Logs(id), &mut stage, ceiling);
    record.logs_stage = stage;
    if let Some(Err(error)) = result
        .map(|result| result.and_then(|output| log::write(record, &output.stdout, &output.stderr)))
    {
        record.note(error);
    }
}
fn remove(
    runtime: &WorkerRuntime,
    record: &mut Record,
    id: &ContainerId,
    ceiling: Option<Instant>,
) {
    let mut stage = record.removal_stage;
    let result = cleanup_call(runtime, record, Query::Remove(id), &mut stage, ceiling);
    record.removal_stage = stage;
    match result {
        Some(Ok(output)) if output.succeeded => record.removal_confirmed = true,
        Some(Ok(_)) => {
            record.unknown_effect = true;
            record.note(NixError::Refused(NixFault::EngineFailed));
        }
        Some(Err(error)) => record.note(error),
        None => {}
    }
}
/// Keep the original per-purpose budget across admission contention and later
/// settlement polls. An earlier caller ceiling defers the intention without
/// renewing it. Only an actual admitted CapturedCall consumes its one dispatch.
fn cleanup_call(
    runtime: &WorkerRuntime,
    record: &mut Record,
    query: Query<'_>,
    stage: &mut CleanupStage,
    ceiling: Option<Instant>,
) -> Option<Result<CapturedOutput>> {
    let CleanupStage::NotSubmitted(original) = *stage else {
        return None;
    };
    let original = original.unwrap_or_else(|| Instant::now() + Duration::from_secs(20));
    *stage = CleanupStage::NotSubmitted(Some(original));
    loop {
        let deadline = runtime
            .stop_deadline()
            .map_or(original, |stop| original.min(stop));
        if Instant::now() >= deadline {
            *stage = CleanupStage::Expired;
            return Some(Err(NixError::Refused(NixFault::Deadline)));
        }
        if ceiling.is_some_and(|ceiling| Instant::now() >= ceiling) {
            return None;
        }
        let until = ceiling.map_or(deadline, |ceiling| deadline.min(ceiling));
        match drive::submit(runtime, record, &query, until) {
            Submission::Busy => std::thread::sleep(Duration::from_millis(5)),
            Submission::Admitted(result) => {
                *stage = CleanupStage::Admitted;
                return Some(result);
            }
            Submission::Refused(error) => {
                if ceiling.is_some_and(|ceiling| Instant::now() >= ceiling)
                    && Instant::now() < deadline
                {
                    return None;
                }
                *stage = CleanupStage::Expired;
                return Some(Err(error));
            }
        }
    }
}

fn settled_client(runtime: &WorkerRuntime, record: &mut Record, ceiling: Option<Instant>) -> bool {
    let Some(call) = record.pending_call.as_ref() else {
        return true;
    };
    let mut deadline = ceiling.unwrap_or_else(Instant::now);
    if let Some(stop) = runtime.stop_deadline() {
        deadline = deadline.min(stop);
    }
    match runtime
        .installed_engine()
        .engine
        .client
        .settle_call(call, deadline)
    {
        Ok(()) => {
            record.pending_call = None;
            record.last_settlement = None;
            true
        }
        Err(error) => {
            // Replace the bounded observation, rather than accumulating one
            // error per poll. The shared process retains cumulative finalizer
            // faults; the original operation error remains in outcome.
            record.last_settlement = Some(error.into());
            false
        }
    }
}
