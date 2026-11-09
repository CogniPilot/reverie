//! Real moved Nix/storage/network→cold→create→start→memory→commit chain.
use super::*;
mod finalizer;
mod retained;
use crate::command_telemetry::CommandTelemetry;
use std::os::unix::fs::DirBuilderExt;
fn policy(fixture: &mut Fixture, strategy: &str) {
    let mut raw: serde_json::Value =
        serde_json::from_slice(&worker_config::encode_config(&fixture.source)).unwrap();
    raw["coldTemporaryCleanup"] =
        json!({"version":1,"enabled":true,"hostLeaseDirectories":[],"strategy":strategy});
    fixture.source = worker_config::decode(&serde_json::to_vec(&raw).unwrap()).unwrap();
}
fn network(fixture: &Fixture) -> LaptopWorkflow {
    let (nix, plan, request, phone) = fixture.resources();
    let workflow = fixture
        .runtime()
        .retain_laptop_network(&nix, plan, request, phone)
        .unwrap_or_else(|_| panic!("actual retain"));
    fixture
        .runtime()
        .run_laptop_network(&workflow, end())
        .unwrap();
    workflow
}
fn employee(fixture: &Fixture) {
    fs::write(fixture.root.join("company.json"),serde_json::to_vec(&json!({"employees":[{"id":"11111111-2222-4333-8444-555555555555","sessionId":SID,"owner":null,"desiredRunning":true,"name":"Native source fixture"}]})).unwrap()).unwrap();
}
fn seed_target(workflow: &LaptopWorkflow) -> PathBuf {
    let target = workflow
        .record
        .try_lock()
        .unwrap()
        .resources()
        .plan
        .storage()
        .scratch()
        .join("tmp");
    // Seed an actual private previous TMP tree, not default0755 test parents.
    // The production preparation must continue refusing those public parents.
    fs::DirBuilder::new()
        .mode(0o700)
        .recursive(true)
        .create(&target)
        .unwrap();
    target
}
#[test]
fn absent_policy_prepares_same_record_once_without_native_commands() {
    if crate::test_process::isolate_case(
        "worker_laptop::tests::cold_prepare::absent_policy_prepares_same_record_once_without_native_commands",
    ) {
        return;
    }
    let fixture = Fixture::new("created-cold");
    let workflow = network(&fixture);
    let trace = fs::read(fixture.root.join("trace")).unwrap();
    let other = Fixture::new("created-cold");
    assert!(
        other
            .runtime()
            .prepare_laptop_cold_temporary(&workflow, end())
            .is_err()
    );
    let ColdPreparation::Prepared(prepared) = fixture
        .runtime()
        .prepare_laptop_cold_temporary(&workflow, end())
        .unwrap()
    else {
        panic!("actual absent preparation")
    };
    assert!(prepared.same_workflow(&workflow));
    assert!(
        fixture
            .runtime()
            .prepare_laptop_cold_temporary(&workflow, end())
            .is_err()
    );
    assert_eq!(fs::read(fixture.root.join("trace")).unwrap(), trace);
}

#[test]
fn absent_policy_creates_missing_session_and_employee_temporary_bind_sources() {
    if crate::test_process::isolate_case(
        "worker_laptop::tests::cold_prepare::absent_policy_creates_missing_session_and_employee_temporary_bind_sources",
    ) {
        return;
    }
    for employee_storage in [false, true] {
        let fixture = Fixture::new("created-cold");
        if employee_storage {
            employee(&fixture);
        }
        let workflow = network(&fixture);
        let scratch = workflow
            .record
            .try_lock()
            .unwrap()
            .resources()
            .plan
            .storage()
            .scratch()
            .to_owned();
        assert!(!scratch.exists());
        let trace = fs::read(fixture.root.join("trace")).unwrap();
        let prepared = fixture
            .runtime()
            .prepare_laptop_cold_temporary(&workflow, end())
            .unwrap();
        let directories = [fs::symlink_metadata(&scratch), fs::symlink_metadata(scratch.join("tmp"))];
        let same_workflow = matches!(prepared, ColdPreparation::Prepared(ref value) if value.same_workflow(&workflow));
        let after = fs::read(fixture.root.join("trace")).unwrap();
        let returned = fixture
            .runtime()
            .reclaim_laptop_network(workflow)
            .unwrap_or_else(|_| panic!("known preparation returns its original owners"));
        fixture.close_resources(returned).unwrap();
        assert!(same_workflow);
        assert_eq!(trace, after, "temporary preparation must not invoke the engine");
        for directory in directories {
            let directory = directory.expect("cold create requires both actual temporary bind sources");
            assert!(directory.is_dir());
            assert_eq!(directory.permissions().mode() & 0o777, 0o700);
            assert_eq!(directory.uid(), crate::native::uid());
        }
    }
}
#[test]
fn enabled_skipped_preparation_never_reaches_create_or_claims_a_cold_phase() {
    if crate::test_process::isolate_case(
        "worker_laptop::tests::cold_prepare::enabled_skipped_preparation_never_reaches_create_or_claims_a_cold_phase",
    ) {
        return;
    }
    for strategy in ["clear", "retain-and-replace"] {
        let mut fixture = Fixture::new("created-cold");
        policy(&mut fixture, strategy);
        if strategy == "retain-and-replace" {
            let (nix, plan, request, phone) = fixture.resources();
            let trace = fs::read(fixture.root.join("trace")).unwrap_or_default();
            let Err(failure) = fixture
                .runtime()
                .retain_laptop_network(&nix, plan, request, phone)
            else {
                panic!("retention must prepare before actual network transfer");
            };
            assert!(matches!(failure.cause(), LaptopError::ColdStorage(_)));
            assert_eq!(
                fs::read(fixture.root.join("trace")).unwrap_or_default(),
                trace
            );
            assert!(!fixture.root.join("created-laptop").exists());
            continue;
        }
        let workflow = network(&fixture);
        let telemetry = CommandTelemetry::capture(fixture.runtime(), &fixture.source).unwrap();
        assert!(matches!(
            fixture
                .runtime()
                .create_laptop(&workflow, &telemetry, end())
                .unwrap(),
            LaptopCreation::Rejected
        ));
        assert!(!fixture.root.join("created-laptop").exists());
    }
}
#[test]
fn actual_employee_clear_proof_moves_through_create_start_memory_and_commit() {
    if crate::test_process::isolate_cold_namespace(
        "worker_laptop::tests::cold_prepare::actual_employee_clear_proof_moves_through_create_start_memory_and_commit",
    ) {
        return;
    }
    let mut fixture = Fixture::new("created-cold");
    policy(&mut fixture, "clear");
    employee(&fixture);
    let workflow = network(&fixture);
    let target = seed_target(&workflow);
    fs::write(target.join("disposable"), b"owned old tmp").unwrap();
    let before = fs::metadata(&target).unwrap();
    let ColdPreparation::Prepared(prepared) = fixture
        .runtime()
        .prepare_laptop_cold_temporary(&workflow, end())
        .unwrap()
    else {
        panic!("actual clear: {:?}", workflow.failure().unwrap())
    };
    assert!(prepared.same_workflow(&workflow));
    assert_eq!(fs::read_dir(&target).unwrap().count(), 0);
    assert_eq!(fs::metadata(&target).unwrap().ino(), before.ino());
    let telemetry = CommandTelemetry::capture(fixture.runtime(), &fixture.source).unwrap();
    let LaptopCreation::Created(created) = fixture
        .runtime()
        .create_laptop(&workflow, &telemetry, end())
        .unwrap()
    else {
        panic!("actual create: {:?}", workflow.failure().unwrap())
    };
    fixture.runtime().publish_laptop_launch(&created).unwrap();
    let ContainerStart::Started(started) = fixture
        .runtime()
        .start_laptop_container(&created, end())
        .unwrap()
    else {
        panic!("actual start: {:?}", workflow.failure().unwrap())
    };
    let MemoryConfiguration::Configured(configured) = fixture
        .runtime()
        .configure_started_laptop_memory(&started, end())
        .unwrap()
    else {
        panic!("actual no-helper memory")
    };
    let ColdCommit::Committed(committed) = fixture
        .runtime()
        .commit_started_laptop_cold(&configured, end())
        .unwrap()
    else {
        panic!("actual clear commit")
    };
    assert!(committed.same_workflow(&workflow));
    let record = workflow.record.try_lock().unwrap();
    assert!(
        !record
            .resources()
            .plan
            .storage()
            .root()
            .join("cold-tmp-cleanup.pending.json")
            .exists()
    );
}

#[test]
fn native_failure_before_and_after_deletion_retains_pending_and_same_record() {
    if crate::test_process::isolate_cold_namespace(
        "worker_laptop::tests::cold_prepare::native_failure_before_and_after_deletion_retains_pending_and_same_record",
    ) {
        return;
    }
    for fail_at in [5, 7] {
        let mut fixture = Fixture::new("created-cold");
        policy(&mut fixture, "clear");
        employee(&fixture);
        let workflow = network(&fixture);
        let (target, control, home) = {
            let record = workflow.record.try_lock().unwrap();
            let paths = record.resources().plan.storage();
            (
                paths.scratch().join("tmp"),
                paths.root().to_owned(),
                paths.home().to_owned(),
            )
        };
        assert_eq!(seed_target(&workflow), target);
        fs::write(target.join("payload"), b"owned disposable").unwrap();
        fs::write(home.join("durable"), b"never tmp").unwrap();
        fs::write(fixture.root.join("cold-fail-ps-at"), fail_at.to_string()).unwrap();
        assert!(matches!(
            fixture
                .runtime()
                .prepare_laptop_cold_temporary(&workflow, end())
                .unwrap(),
            ColdPreparation::Retained
        ));
        assert_eq!(
            workflow.failure().unwrap().unwrap().code(),
            "WORKER_COLD_EFFECT_UNCONFIRMED"
        );
        let pending = control.join("cold-tmp-cleanup.pending.json");
        let original = fs::read(&pending).unwrap();
        let record: serde_json::Value = serde_json::from_slice(&original).unwrap();
        assert_eq!(record["state"], "ATTEMPT");
        if fail_at == 5 {
            assert_eq!(
                fs::read(target.join("payload")).unwrap(),
                b"owned disposable"
            );
        } else {
            assert_eq!(fs::read_dir(&target).unwrap().count(), 0);
        }
        assert_eq!(fs::read(home.join("durable")).unwrap(), b"never tmp");
        assert!(!fs::read_dir(&control).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("cold-tmp-complete-")
        }));
        let trace = fs::read(fixture.root.join("trace")).unwrap();
        assert!(
            fixture
                .runtime()
                .prepare_laptop_cold_temporary(&workflow, end())
                .is_err()
        );
        assert_eq!(fs::read(&pending).unwrap(), original);
        assert_eq!(fs::read(fixture.root.join("trace")).unwrap(), trace);
        assert!(!fixture.root.join("created-laptop").exists());
    }
}
