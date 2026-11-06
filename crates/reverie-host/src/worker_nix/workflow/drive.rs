use super::*;
use crate::captured_client::{CancellationToken, CapturedOutput, Policy};
use reverie_contracts::worker_nix::{self, NixHelperState, NixPreviousHelper};
use std::ffi::OsString;

pub(super) enum Query<'a> {
    Image(&'a MetadataText),
    Previous(&'a MetadataText),
    RemovePrevious(&'a ContainerId),
    Create(&'a NixPreparationArguments),
    Start(&'a ContainerId),
    State(&'a ContainerId),
    Logs(&'a ContainerId),
    Remove(&'a ContainerId),
}
impl Query<'_> {
    fn arguments(&self) -> Result<Vec<OsString>> {
        let arguments = match self {
            Self::Image(image) => vec!["image".into(), "inspect".into(), os(image)?],
            Self::Previous(name) => vec!["inspect".into(), os(name)?],
            Self::RemovePrevious(id) => vec!["rm".into(), id.as_str().into()],
            Self::Create(plan) => plan.arguments().iter().map(os).collect::<Result<_>>()?,
            Self::Start(id) => vec!["start".into(), id.as_str().into()],
            Self::State(id) => vec!["inspect".into(), id.as_str().into()],
            Self::Logs(id) => vec![
                "logs".into(),
                "--tail".into(),
                "100".into(),
                id.as_str().into(),
            ],
            Self::Remove(id) => vec!["rm".into(), "--force".into(), id.as_str().into()],
        };
        Ok(arguments)
    }
    fn launching(&self) -> bool {
        matches!(self, Self::Create(_) | Self::Start(_))
    }
    fn unknown_without_success(&self) -> bool {
        matches!(
            self,
            Self::Create(_) | Self::RemovePrevious(_) | Self::Remove(_)
        )
    }
}
fn os(text: &MetadataText) -> Result<OsString> {
    Ok(native::python_path(text.codepoints())?.into_os_string())
}
pub(super) enum Submission {
    Busy,
    Refused(NixError),
    Admitted(Result<CapturedOutput>),
}
pub(super) fn call(
    runtime: &WorkerRuntime,
    record: &mut Record,
    query: Query<'_>,
    ceiling: Option<Instant>,
) -> Result<CapturedOutput> {
    let mut deadline = Instant::now() + Duration::from_secs(20);
    if let Some(ceiling) = ceiling {
        deadline = deadline.min(ceiling);
    }
    loop {
        match submit(runtime, record, &query, deadline) {
            Submission::Busy => std::thread::sleep(Duration::from_millis(5)),
            Submission::Refused(error) => return Err(error),
            Submission::Admitted(result) => return result,
        }
    }
}
/// Busy means the common context did not admit this operation. Only that pure
/// admission may be attempted again; a real admitted call is never replayed.
pub(super) fn submit(
    runtime: &WorkerRuntime,
    record: &mut Record,
    query: &Query<'_>,
    deadline: Instant,
) -> Submission {
    if query.launching() && runtime.cancellation().is_cancelled() {
        return Submission::Refused(NixError::Refused(NixFault::Cancelled));
    }
    let args = match query.arguments() {
        Ok(args) => args,
        Err(error) => return Submission::Refused(error),
    };
    let deadline = runtime
        .stop_deadline()
        .map_or(deadline, |stop| deadline.min(stop));
    let token = if query.launching() {
        runtime.cancellation()
    } else {
        CancellationToken::new()
    };
    let result = runtime.installed_engine().engine.client.run_scoped(
        args,
        deadline,
        &token,
        Policy {
            maximum: Duration::from_secs(20),
            maximum_output: 4 * 1024 * 1024,
            successful_exit: false,
        },
    );
    match result {
        Ok(output) => {
            if !output.succeeded && query.unknown_without_success() {
                record.unknown_effect = true;
            }
            Submission::Admitted(Ok(output))
        }
        Err(failure) => {
            let admitted = failure.call.is_some();
            let error = failure.error;
            if !admitted && error.fault == crate::captured_client::Fault::Busy {
                return Submission::Busy;
            }
            if error.is_uncertain() && admitted {
                record.pending_call = failure.call;
            }
            record.unknown_effect |= error.may_have_started && query.unknown_without_success();
            let error = NixError::Engine(error.into());
            if admitted {
                Submission::Admitted(Err(error))
            } else {
                Submission::Refused(error)
            }
        }
    }
}
fn success(output: CapturedOutput) -> Result<CapturedOutput> {
    need(output.succeeded, NixFault::EngineFailed)?;
    Ok(output)
}
fn allowed(runtime: &WorkerRuntime, record: &Record) -> Result<bool> {
    if runtime.cancellation().is_cancelled() {
        return Ok(false);
    }
    Ok(crate::worker_intent::read_allowed(
        &record.prepared,
        record.resources().guard.session(),
    )?)
}
fn acquire_turn(runtime: &WorkerRuntime, workflows: &Workflows, record: &mut Record) -> Result<()> {
    loop {
        if workflows
            .turn
            .compare_exchange(0, record.id, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            record.turn = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(250));
        need(
            Instant::now() < record.deadline.expect("original post-prefix budget"),
            NixFault::Deadline,
        )?;
        need(allowed(runtime, record)?, NixFault::Cancelled)?;
    }
    need(allowed(runtime, record)?, NixFault::Cancelled)
}
pub(super) fn execute(
    runtime: &WorkerRuntime,
    workflows: &Workflows,
    record: &mut Record,
) -> Result<NixDisposition> {
    let config = NixConfiguration::capture(&record.prepared);
    let image = success(call(runtime, record, Query::Image(&config.image()?), None)?)?;
    if !worker_nix::image_supports_private_store(&image.stdout)? {
        return Ok(NixDisposition::NoHelper);
    }
    // The legacy image branch above must do no fresh storage/FD observations.
    record.resources().storage.check_resource_current()?;
    let prepared = record.prepared.clone();
    let selected = record
        .resources_mut()
        .guard
        .prepare_private_store(&prepared)?;
    record.prepared_store = Some(selected.clone());
    let plan = record
        .resources()
        .guard
        .preparation_arguments(&prepared, &selected)?;
    let current =
        storage_identity::storage_paths(&identity(&config)?, record.resources().guard.session())?;
    need(
        current == *record.resources().storage.paths(),
        NixFault::StoreBinding,
    )?;
    record.deadline = Some(Instant::now() + Duration::from_secs(300));
    acquire_turn(runtime, workflows, record)?;
    previous(runtime, record, &config, plan.name())?;
    let created = success(call(runtime, record, Query::Create(&plan), None)?)?;
    let id = match worker_nix::created_identity(
        std::str::from_utf8(&created.stdout).expect("strict capture"),
    ) {
        Ok(id) => id,
        Err(error) => {
            record.unknown_effect = true;
            return Err(error.into());
        }
    };
    record.helper = Some(id.clone());
    success(call(runtime, record, Query::Start(&id), None)?)?;
    wait(runtime, record, &id)?;
    Ok(NixDisposition::Prepared)
}
fn previous(
    runtime: &WorkerRuntime,
    record: &mut Record,
    config: &NixConfiguration,
    name: &MetadataText,
) -> Result<()> {
    let previous = call(runtime, record, Query::Previous(name), None)?;
    if !previous.succeeded {
        return Ok(());
    }
    let previous = NixPreviousHelper::capture(
        &previous.stdout,
        &config.deployment()?,
        record.resources().guard.session(),
    )?;
    success(call(
        runtime,
        record,
        Query::RemovePrevious(previous.identity()),
        None,
    )?)?;
    Ok(())
}
fn wait(runtime: &WorkerRuntime, record: &mut Record, id: &ContainerId) -> Result<()> {
    loop {
        let output = success(call(runtime, record, Query::State(id), None)?)?;
        match worker_nix::helper_state(&output.stdout)? {
            NixHelperState::Succeeded => return Ok(()),
            NixHelperState::Failed => return Err(NixError::Refused(NixFault::HelperFailed)),
            NixHelperState::Running => {}
        }
        // Test-only observation after the real checked call has returned and
        // its stdout/exit/pipe cleanup completed. It supplies no result/permit.
        #[cfg(test)]
        if let Some(gate) = record.after_running_state.take() {
            gate.entered.store(true, Ordering::Release);
            let ceiling = Instant::now() + Duration::from_secs(15);
            while !gate.released.load(Ordering::Acquire) {
                assert!(
                    Instant::now() < ceiling,
                    "owning setup releases checked state"
                );
                std::thread::sleep(Duration::from_millis(1));
            }
        }
        need(
            Instant::now() < record.deadline.expect("original budget"),
            NixFault::Deadline,
        )?;
        need(allowed(runtime, record)?, NixFault::Cancelled)?;
        let until = Instant::now() + Duration::from_millis(500);
        while Instant::now() < until && !runtime.cancellation().is_cancelled() {
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}
