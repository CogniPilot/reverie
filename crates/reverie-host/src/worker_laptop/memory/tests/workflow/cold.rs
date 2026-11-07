//! Genuine create/publication/start/memory owner chain; no test phase mint.
use super::*;
use crate::worker_laptop::ColdCommit;

fn configured(fixture: &Fixture) -> (LaptopWorkflow, ConfiguredMemory) {
    let (workflow, started) = actual_started(fixture, None);
    let MemoryConfiguration::Configured(configured) = fixture
        .runtime()
        .configure_started_laptop_memory(&started, end())
        .unwrap()
    else {
        panic!("actual configured memory")
    };
    (workflow, configured)
}
fn isolate(name: &str) -> bool {
    crate::test_process::isolate_case(&format!(
        "worker_laptop::memory::tests::workflow::cold::{name}"
    ))
}
#[test]
fn absent_policy_commits_exact_same_record_once_without_another_native_command() {
    if isolate("absent_policy_commits_exact_same_record_once_without_another_native_command") {
        return;
    }
    let fixture = Fixture::new("created-memory");
    let (workflow, configured) = configured(&fixture);
    let trace = fs::read(fixture.root.join("trace")).unwrap();
    let other = Fixture::new("created-memory");
    assert!(
        other
            .runtime()
            .commit_started_laptop_cold(&configured, end())
            .is_err()
    );
    let ColdCommit::Committed(committed) = fixture
        .runtime()
        .commit_started_laptop_cold(&configured, end())
        .unwrap()
    else {
        panic!("actual cold phase")
    };
    assert!(committed.same_workflow(&workflow));
    assert!(
        fixture
            .runtime()
            .commit_started_laptop_cold(&configured, end())
            .is_err()
    );
    assert_eq!(fs::read(fixture.root.join("trace")).unwrap(), trace);
    let record = workflow.record.try_lock().unwrap();
    assert!(record.creation.as_ref().unwrap().stage == create::CreateStage::ColdCommitted);
}
#[test]
fn absent_policy_pending_even_broken_fences_before_token_and_never_replays() {
    if isolate("absent_policy_pending_even_broken_fences_before_token_and_never_replays") {
        return;
    }
    let fixture = Fixture::new("created-memory");
    let (workflow, configured) = configured(&fixture);
    let control = workflow
        .record
        .try_lock()
        .unwrap()
        .resources()
        .plan
        .storage()
        .root()
        .to_owned();
    let marker = control.join("cold-tmp-cleanup.pending.json");
    std::os::unix::fs::symlink("absent-owned-pending", &marker).unwrap();
    let trace = fs::read(fixture.root.join("trace")).unwrap();
    assert!(matches!(
        fixture
            .runtime()
            .commit_started_laptop_cold(&configured, end())
            .unwrap(),
        ColdCommit::Rejected
    ));
    assert!(fs::symlink_metadata(&marker).unwrap().is_symlink());
    assert!(
        fixture
            .runtime()
            .commit_started_laptop_cold(&configured, end())
            .is_err()
    );
    assert_eq!(fs::read(fixture.root.join("trace")).unwrap(), trace);
}
#[test]
fn absent_policy_original_deadline_and_cancel_refuse_before_any_new_dispatch() {
    if isolate("absent_policy_original_deadline_and_cancel_refuse_before_any_new_dispatch") {
        return;
    }
    for cancelled in [false, true] {
        let fixture = Fixture::new("created-memory");
        let (_, configured) = configured(&fixture);
        let trace = fs::read(fixture.root.join("trace")).unwrap();
        let deadline = if cancelled {
            fixture.runtime().cancellation().cancel();
            end()
        } else {
            Instant::now() - Duration::from_secs(1)
        };
        assert!(matches!(
            fixture
                .runtime()
                .commit_started_laptop_cold(&configured, deadline)
                .unwrap(),
            ColdCommit::Rejected
        ));
        assert!(
            fixture
                .runtime()
                .commit_started_laptop_cold(&configured, end())
                .is_err()
        );
        assert_eq!(fs::read(fixture.root.join("trace")).unwrap(), trace);
    }
}
#[test]
fn enabled_strategies_cannot_obtain_cold_token_without_their_real_transaction() {
    if isolate("enabled_strategies_cannot_obtain_cold_token_without_their_real_transaction") {
        return;
    }
    for strategy in ["clear", "retain-and-replace"] {
        let mut fixture = Fixture::new("created-memory");
        let mut raw: serde_json::Value =
            serde_json::from_slice(&worker_config::encode_config(&fixture.source)).unwrap();
        raw["coldTemporaryCleanup"] =
            json!({"version":1,"enabled":true,"hostLeaseDirectories":[],"strategy":strategy});
        fixture.source = worker_config::decode(&serde_json::to_vec(&raw).unwrap()).unwrap();
        let (nix, plan, request, phone) = fixture.resources_with_effective(
            &ProfileSessionId::parse(SID).unwrap(),
            fixture.source.clone(),
        );
        if strategy == "retain-and-replace" {
            let trace = fs::read(fixture.root.join("trace")).unwrap_or_default();
            let Err(failure) = fixture
                .runtime()
                .retain_laptop_network(&nix, plan, request, phone)
            else {
                panic!("unprepared retention cannot reach network/create/start/memory");
            };
            assert!(matches!(failure.cause(), LaptopError::ColdStorage(_)));
            assert_eq!(
                fs::read(fixture.root.join("trace")).unwrap_or_default(),
                trace
            );
            assert!(!fixture.root.join("created-laptop").exists());
            continue;
        }
        let workflow = fixture
            .runtime()
            .retain_laptop_network(&nix, plan, request, phone)
            .unwrap_or_else(|_| panic!("actual network retain"));
        fixture
            .runtime()
            .run_laptop_network(&workflow, end())
            .unwrap();
        let telemetry = CommandTelemetry::capture(fixture.runtime(), &fixture.source).unwrap();
        let trace = fs::read(fixture.root.join("trace")).unwrap();
        assert!(matches!(
            fixture
                .runtime()
                .create_laptop(&workflow, &telemetry, end())
                .unwrap(),
            LaptopCreation::Rejected
        ));
        assert!(matches!(
            workflow.failure().unwrap().unwrap().as_ref(),
            LaptopError::ColdStorage(_)
        ));
        assert!(
            !fixture.root.join("created-laptop").exists(),
            "no Started/ConfiguredMemory/ColdCommitted token can precede actual enabled preparation"
        );
        assert_eq!(fs::read(fixture.root.join("trace")).unwrap(), trace);
    }
}
#[test]
fn absent_policy_rebound_real_nix_lock_refuses_and_preserves_foreign_replacement() {
    if isolate("absent_policy_rebound_real_nix_lock_refuses_and_preserves_foreign_replacement") {
        return;
    }
    let fixture = Fixture::new("created-memory");
    let (_, configured) = configured(&fixture);
    let lock = fixture.root.join("state").join(SID).join("nix.lock");
    fs::rename(&lock, lock.with_extension("retained-original")).unwrap();
    fs::write(&lock, b"foreign replacement stays unchanged").unwrap();
    let trace = fs::read(fixture.root.join("trace")).unwrap();
    assert!(matches!(
        fixture
            .runtime()
            .commit_started_laptop_cold(&configured, end())
            .unwrap(),
        ColdCommit::Rejected
    ));
    assert!(
        fixture
            .runtime()
            .commit_started_laptop_cold(&configured, end())
            .is_err()
    );
    assert_eq!(
        fs::read(&lock).unwrap(),
        b"foreign replacement stays unchanged"
    );
    assert_eq!(fs::read(fixture.root.join("trace")).unwrap(), trace);
}
#[test]
fn absent_policy_expired_original_stop_never_accepts_new_caller_budget() {
    if isolate("absent_policy_expired_original_stop_never_accepts_new_caller_budget") {
        return;
    }
    let fixture = Fixture::new("created-memory");
    let (_, configured) = configured(&fixture);
    let trace = fs::read(fixture.root.join("trace")).unwrap();
    fixture
        .runtime()
        .installed_engine()
        .expire_stop_for_owned_test();
    assert!(matches!(
        fixture
            .runtime()
            .commit_started_laptop_cold(&configured, end())
            .unwrap(),
        ColdCommit::Rejected
    ));
    assert_eq!(fs::read(fixture.root.join("trace")).unwrap(), trace);
    fixture.retain_after_expired_stop();
}
