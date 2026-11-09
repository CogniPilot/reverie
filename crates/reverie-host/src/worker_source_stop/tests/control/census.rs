//! Original C census admission and failure custody with actual private clients.
use super::*;
use crate::captured_client::test_hooks::Hooks;
use crate::engine_metadata::{CancellationToken, EngineFault, EngineQuery};
use reverie_contracts::worker_schema::WorkerEnvelope;
use std::{
    path::PathBuf,
    process::Command,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

struct Release(PathBuf);
impl Drop for Release {
    fn drop(&mut self) {
        fs::write(&self.0, b"release actual metadata").unwrap();
    }
}
fn wait(mut ready: impl FnMut() -> bool) {
    let end = end();
    while !ready() {
        assert!(Instant::now() < end, "original census phase observed");
        std::thread::sleep(Duration::from_millis(1));
    }
}
fn census(fixture: &Fixture) -> ControlStopCensus {
    fs::write(fixture.root.join("legacy-stop"), b"fixed census fixture").unwrap();
    fs::write(
        fixture.root.join("running-names"),
        format!("test-agent-{SID}\n"),
    )
    .unwrap();
    let envelope = WorkerEnvelope::capture(fixture.config.clone()).unwrap();
    fixture
        .runtime
        .control_stop_census(envelope.base(), end())
        .unwrap()
}
fn census_calls(fixture: &Fixture) -> usize {
    fixture
        .trace()
        .iter()
        .filter(|line| line.starts_with("ps\0--filter\0"))
        .count()
}

#[test]
fn read_waits_for_original_sibling_then_issues_one_census_without_cancelling_it() {
    if isolated(
        "worker_source_stop::tests::control::census::read_waits_for_original_sibling_then_issues_one_census_without_cancelling_it",
    ) {
        return;
    }
    let fixture = Fixture::new("never");
    let mut census = census(&fixture);
    let (metadata, result, before) = std::thread::scope(|scope| {
        let release = Release(fixture.root.join("release-metadata"));
        let readonly = fixture.runtime.readonly();
        let metadata = scope.spawn(move || {
            readonly.query(EngineQuery::InventoryIds, end(), &CancellationToken::new())
        });
        wait(|| fixture.root.join("metadata-entered").is_file());
        let observed = Arc::new(AtomicBool::new(false));
        let probe = observed.clone();
        let read = scope.spawn(|| {
            call::probe::observe_next(probe);
            census.read(&fixture.runtime)
        });
        wait(|| observed.load(Ordering::Acquire));
        let before = census_calls(&fixture);
        drop(release);
        (metadata.join().unwrap(), read.join().unwrap(), before)
    });
    let calls = census_calls(&fixture);
    let settled = census.settle(&fixture.runtime, end());
    drop(census);
    drop(fixture);
    assert_eq!(metadata.unwrap(), "");
    settled.unwrap();
    assert_eq!(
        before, 0,
        "no census dispatch while original sibling owns slot"
    );
    assert_eq!(calls, 1, "one admitted census, no replay");
    assert_eq!(result.unwrap().entries().len(), 1);
}

#[test]
fn first_stop_during_census_admission_wait_prevents_dispatch_and_sibling_settlement() {
    if isolated(
        "worker_source_stop::tests::control::census::first_stop_during_census_admission_wait_prevents_dispatch_and_sibling_settlement",
    ) {
        return;
    }
    let fixture = Fixture::new("never");
    let mut census = census(&fixture);
    let (metadata, result) = std::thread::scope(|scope| {
        let release = Release(fixture.root.join("release-metadata"));
        let readonly = fixture.runtime.readonly();
        let metadata = scope.spawn(move || {
            readonly.query(EngineQuery::InventoryIds, end(), &CancellationToken::new())
        });
        wait(|| fixture.root.join("metadata-entered").is_file());
        let observed = Arc::new(AtomicBool::new(false));
        let probe = observed.clone();
        let read = scope.spawn(|| {
            call::probe::observe_next(probe);
            census.read(&fixture.runtime)
        });
        wait(|| observed.load(Ordering::Acquire));
        fixture
            .runtime
            .installed_engine()
            .expire_stop_for_owned_test();
        let result = read.join().unwrap();
        drop(release);
        (metadata.join().unwrap(), result)
    });
    let calls = census_calls(&fixture);
    let settled = census.settle(&fixture.runtime, end());
    drop(census);
    drop(fixture);
    assert_eq!(metadata.unwrap(), "", "waiting census never aborts sibling");
    settled.unwrap();
    assert_eq!(
        result.err().unwrap().code(),
        "RESOURCE_SOURCE_STOP_DEADLINE"
    );
    assert_eq!(calls, 0);
}

#[test]
fn admitted_census_close_unknown_retains_original_ticket_without_second_query() {
    if isolated(
        "worker_source_stop::tests::control::census::admitted_census_close_unknown_retains_original_ticket_without_second_query",
    ) {
        return;
    }
    let hooks = Hooks::default();
    hooks.close_failed.store(true, Ordering::Release);
    let mut fixture = Fixture::with_hooks("never", hooks);
    fixture.expect_retained_runtime();
    let mut census = census(&fixture);
    let body = census.read(&fixture.runtime);
    let settled = census.settle(&fixture.runtime, end());
    let second = census.read(&fixture.runtime);
    let calls = census_calls(&fixture);
    drop(census);
    drop(fixture);
    assert!(matches!(body, Err(SourceStopError::Engine(error)) if error.is_uncertain()));
    assert!(settled.is_err(), "consumed close remains unknown");
    assert_eq!(second.err().unwrap().code(), "WORKER_CONTROL_STOP_ORIGIN");
    assert_eq!(calls, 1);
}

#[test]
fn original_query_diagnostic_preserves_typed_failure_without_command_or_output() {
    const CASE: &str = "worker_source_stop::tests::control::census::original_query_diagnostic_preserves_typed_failure_without_command_or_output";
    const FLAG: &str = "REVERIE_OWNED_CENSUS_DIAGNOSTIC";
    if std::env::var_os(FLAG).is_none() {
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", CASE, "--nocapture", "--test-threads=1"])
            .env(FLAG, "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let stderr = String::from_utf8(output.stderr).unwrap();
        assert!(stderr.contains("WORKER_SOURCE_QUERY_FAILED fault=Exit cleanup=[] admitted=true may_have_started=true uncertain=false"), "{stderr}");
        assert!(!stderr.contains("label=reverie.worker=test"));
        return;
    }
    let fixture = Fixture::new("never");
    let mut census = census(&fixture);
    fs::write(
        fixture.root.join("census-known-refusal"),
        b"fixed native nonzero",
    )
    .unwrap();
    let body = census.read(&fixture.runtime);
    let settled = census.settle(&fixture.runtime, end());
    drop(census);
    drop(fixture);
    assert!(
        matches!(body, Err(SourceStopError::Engine(error)) if error.fault() == EngineFault::Exit)
    );
    settled.unwrap();
}
