//! Fixed final named-laptop liveness DATA over the actual storage and plan.
//! Callers retain their own record's one-shot, pending call and outcome. Neither
//! a missing original CID nor a failed optional inspect establishes absence.
use super::*;
use crate::{captured_client::CapturedCall, worker_storage::LaunchStorage};
use reverie_contracts::worker_source_stop::{OrdinaryContainer, ordinary_container_absent};
use reverie_core::ids::ContainerId;
use std::{ffi::OsString, time::Duration};

pub(crate) fn observe(
    runtime: &WorkerRuntime,
    pending: &mut Option<CapturedCall>,
    storage: &LaunchStorage,
    plan: &ObservedCreatePlan,
    original: Option<&ContainerId>,
) -> Result<bool> {
    need(pending.is_none(), "WORKER_FINAL_STORAGE_CALL_PENDING")?;
    plan.assert_storage_owner(runtime, storage)
        .map_err(LaptopError::Plan)?;
    let name = plan.arguments().name();
    let output = call(runtime, pending, vec!["inspect".into(), name.into()], false)?;
    if output.succeeded {
        let row = OrdinaryContainer::decode(
            &output.stdout,
            name,
            runtime.worker_identity().deployment(),
            plan.session(),
        )
        .map_err(data_error)?;
        need(
            original.is_none_or(|original| row.id() == original),
            "WORKER_FINAL_STORAGE_IDENTITY_CHANGED",
        )?;
        if row.running() {
            return Ok(true);
        }
        need(row.stopped(), "WORKER_FINAL_STORAGE_STATE_UNAVAILABLE")?;
        return Ok(false);
    }
    let census = call(
        runtime,
        pending,
        [
            "ps",
            "--all",
            "--no-trunc",
            "--format",
            "{{.ID}} {{.Names}}",
        ]
        .into_iter()
        .map(OsString::from)
        .collect(),
        true,
    )?;
    let absent = ordinary_container_absent(&census.stdout, name, original).map_err(data_error)?;
    need(absent, "WORKER_FINAL_STORAGE_STATE_UNAVAILABLE")?;
    Ok(false)
}
fn call(
    runtime: &WorkerRuntime,
    pending: &mut Option<CapturedCall>,
    arguments: Vec<OsString>,
    required: bool,
) -> Result<crate::captured_client::CapturedOutput> {
    crate::worker_source_stop::captured_worker_cleanup(
        runtime.installed_engine(),
        Instant::now() + Duration::from_secs(20),
        pending,
        arguments,
        required,
    )
    .map_err(|error| match error {
        crate::worker_source_stop::SourceStopError::Engine(error) => LaptopError::Engine(error),
        crate::worker_source_stop::SourceStopError::Refused(code) => LaptopError::Refused(code),
        error => LaptopError::OrdinaryStop(error),
    })
}
fn data_error(error: reverie_contracts::worker_source_stop::SourceStopDataError) -> LaptopError {
    LaptopError::OrdinaryStop(crate::worker_source_stop::SourceStopError::Data(error))
}
