//! Closed original network inspection/creation commands on the same capture.
use super::*;
use crate::captured_client::{CancellationToken, CapturedOutput, Fault, Policy};
use std::{ffi::OsString, time::Duration};
pub(super) fn run(runtime: &WorkerRuntime, record: &mut Record, ceiling: Instant) -> Result<()> {
    let name = format!("{}-lan", record.resources().plan.arguments().name());
    let state = call(
        runtime,
        record,
        vec!["network".into(), "inspect".into(), name.clone().into()],
        false,
        ceiling,
    )?;
    if state.succeeded {
        return reverie_contracts::worker_launch::assert_network_labels(
            &state.stdout,
            runtime.worker_identity().deployment(),
            record.resources().plan.session(),
        )
        .map_err(LaptopError::Network);
    }
    let deployment = runtime.worker_identity().deployment();
    let session = record.resources().plan.session();
    let args = vec![
        "network".into(),
        "create".into(),
        "--label".into(),
        format!("reverie.worker={deployment}").into(),
        "--label".into(),
        format!("reverie.session={session}").into(),
        "--opt".into(),
        "com.docker.network.bridge.enable_icc=false".into(),
        name.into(),
    ];
    let result = call(runtime, record, args, true, ceiling)?;
    if !result.succeeded {
        record.unknown = true;
        return Err(LaptopError::Refused("WORKER_LAPTOP_NETWORK_CREATE_FAILED"));
    }
    Ok(())
}
fn call(
    runtime: &WorkerRuntime,
    record: &mut Record,
    args: Vec<OsString>,
    creating: bool,
    ceiling: Instant,
) -> Result<CapturedOutput> {
    let original = (Instant::now() + Duration::from_secs(20)).min(ceiling);
    loop {
        if creating && runtime.cancellation().is_cancelled() {
            return Err(LaptopError::Refused("WORKER_LAPTOP_STOPPED"));
        }
        let deadline = runtime
            .stop_deadline()
            .map_or(original, |stop| original.min(stop));
        if Instant::now() >= deadline {
            return Err(LaptopError::Refused("WORKER_LAPTOP_DEADLINE"));
        }
        let token = if creating {
            runtime.cancellation()
        } else {
            CancellationToken::new()
        };
        let result = runtime.installed_engine().engine.client.run_scoped(
            args.clone(),
            deadline,
            &token,
            Policy {
                maximum: Duration::from_secs(20),
                maximum_output: 4 * 1024 * 1024,
                successful_exit: false,
            },
        );
        match result {
            Ok(output) => return Ok(output),
            Err(failure) => {
                let admitted = failure.call.is_some();
                if !admitted && failure.error.fault == Fault::Busy {
                    std::thread::sleep(Duration::from_millis(5));
                    continue;
                }
                if admitted && failure.error.is_uncertain() {
                    record.pending = failure.call;
                }
                record.unknown |= creating && admitted && failure.error.may_have_started;
                return Err(LaptopError::Engine(failure.error.into()));
            }
        }
    }
}
