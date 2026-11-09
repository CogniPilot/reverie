use super::*;
use crate::command_telemetry::CommandTelemetry;
mod provider;
fn creates(fixture: &Fixture) -> usize {
    fs::read_to_string(fixture.root.join("trace"))
        .unwrap_or_default()
        .lines()
        .filter(|line| line.starts_with("create\0"))
        .count()
}
#[test]
fn canonical_and_noncanonical_success_keep_actual_created_ownership_without_replay() {
    if isolated("canonical_and_noncanonical_success_keep_actual_created_ownership_without_replay") {
        return;
    }
    for (mode, canonical) in [("created-normal", true), ("created-noncanonical", false)] {
        let fixture = Fixture::new(mode);
        let workflow = fixture.retain();
        let telemetry = CommandTelemetry::capture(fixture.runtime(), &fixture.source).unwrap();
        assert_eq!(
            fixture
                .runtime()
                .run_laptop_network(&workflow, end())
                .unwrap(),
            LaptopNetworkProgress::Ready
        );
        let LaptopCreation::Created(created) = fixture
            .runtime()
            .create_laptop(&workflow, &telemetry, end())
            .unwrap()
        else {
            panic!("actual successful create owns its resources");
        };
        assert_eq!(created.container_id().is_some(), canonical);
        assert!(created.same_workflow(&workflow));
        assert!(
            fixture
                .runtime()
                .create_laptop(&workflow, &telemetry, end())
                .is_err()
        );
        assert!(fixture.runtime().reclaim_laptop_network(workflow).is_err());
        assert!(fixture.runtime().close(end()).is_err());
        assert!(NixStoreGuard::acquire_migration(&fixture.source, &sid()).is_err());
        assert_eq!(creates(&fixture), 1);
        assert!(fixture.root.join("created-laptop").is_file());
    }
}
#[test]
fn nonzero_and_invalid_reply_keep_effect_custody_after_actual_client_settlement() {
    if isolated("nonzero_and_invalid_reply_keep_effect_custody_after_actual_client_settlement") {
        return;
    }
    for mode in ["created-nonzero", "created-bad-utf8"] {
        let fixture = Fixture::new(mode);
        let workflow = fixture.retain();
        let telemetry = CommandTelemetry::capture(fixture.runtime(), &fixture.source).unwrap();
        fixture
            .runtime()
            .run_laptop_network(&workflow, end())
            .unwrap();
        assert!(matches!(
            fixture
                .runtime()
                .create_laptop(&workflow, &telemetry, end())
                .unwrap(),
            LaptopCreation::Retained
        ));
        fixture
            .runtime()
            .installed_engine()
            .settle_owned(end())
            .unwrap();
        assert!(
            fixture
                .runtime()
                .reclaim_laptop_network(workflow.clone())
                .is_err()
        );
        assert!(fixture.runtime().close(end()).is_err());
        assert!(
            fixture
                .runtime()
                .create_laptop(&workflow, &telemetry, end())
                .is_err()
        );
        assert_eq!(creates(&fixture), 1);
        assert!(fixture.root.join("created-laptop").is_file());
        assert!(NixStoreGuard::acquire_migration(&fixture.source, &sid()).is_err());
    }
}

#[test]
fn completed_nonzero_create_keeps_original_bounded_output_and_unknown_without_replay() {
    if isolated("completed_nonzero_create_keeps_original_bounded_output_and_unknown_without_replay")
    {
        return;
    }
    let fixture = Fixture::new("created-nonzero-output");
    let workflow = fixture.retain();
    let telemetry = CommandTelemetry::capture(fixture.runtime(), &fixture.source).unwrap();
    fixture
        .runtime()
        .run_laptop_network(&workflow, end())
        .unwrap();
    assert!(workflow.completed_create_diagnostic().unwrap().is_none());
    assert!(matches!(
        fixture
            .runtime()
            .create_laptop(&workflow, &telemetry, end())
            .unwrap(),
        LaptopCreation::Retained
    ));
    fixture
        .runtime()
        .installed_engine()
        .settle_owned(end())
        .unwrap();
    let diagnostic = workflow
        .completed_create_diagnostic()
        .unwrap()
        .expect("same completed create output retained");
    assert!(!diagnostic.succeeded());
    assert_eq!(diagnostic.shell_code(), 9);
    assert_eq!(diagnostic.stdout(), b"partial daemon reply \n");
    assert_eq!(
        diagnostic.stderr(),
        b"create rejected: fixture mount absent\n"
    );
    let arguments = diagnostic
        .arguments()
        .iter()
        .map(|arg| arg.to_str().unwrap())
        .collect::<Vec<_>>()
        .join("\0");
    assert_eq!(
        arguments,
        fs::read_to_string(fixture.root.join("created-laptop")).unwrap()
    );
    {
        let record = workflow.record.lock().unwrap();
        assert!(record.unknown);
        assert!(record.phase == Phase::Retained);
    }
    let refusal = fixture
        .runtime()
        .create_laptop(&workflow, &telemetry, end())
        .err()
        .expect("one-shot create cannot run again");
    assert!(matches!(
        refusal,
        LaptopError::Refused("WORKER_LAPTOP_CREATE_PHASE")
    ));
    let again = workflow.completed_create_diagnostic().unwrap().unwrap();
    assert!(Arc::ptr_eq(&diagnostic, &again));
    assert_eq!(again.stderr(), b"create rejected: fixture mount absent\n");
    assert_eq!(creates(&fixture), 1);
    assert!(
        fixture
            .runtime()
            .reclaim_laptop_network(workflow.clone())
            .is_err()
    );
    assert!(fixture.runtime().close(end()).is_err());
    assert!(workflow.record.lock().unwrap().unknown);
    assert!(NixStoreGuard::acquire_migration(&fixture.source, &sid()).is_err());
}
#[test]
fn genuine_foreign_telemetry_origin_refuses_before_create_and_returns_original_owners() {
    let fixture = Fixture::new("created-normal");
    let other = Fixture::new("created-normal");
    let workflow = fixture.retain();
    fixture
        .runtime()
        .run_laptop_network(&workflow, end())
        .unwrap();
    let telemetry = CommandTelemetry::capture(other.runtime(), &other.source).unwrap();
    assert!(matches!(
        fixture
            .runtime()
            .create_laptop(&workflow, &telemetry, end())
            .unwrap(),
        LaptopCreation::Rejected
    ));
    let error = workflow.failure().unwrap().unwrap();
    let LaptopError::Telemetry(failure) = error.as_ref() else {
        panic!("typed original telemetry error");
    };
    assert!(matches!(
        &*failure.cause().unwrap(),
        crate::command_telemetry::TelemetryError::Runtime
    ));
    assert_eq!(creates(&fixture), 0);
    let returned = fixture
        .runtime()
        .reclaim_laptop_network(workflow)
        .unwrap_or_else(|_| panic!("known predispatch refusal"));
    assert!(fixture.close_resources(returned).is_err());
}
#[test]
fn actual_late_account_mount_is_checked_by_enabled_collector_before_any_create() {
    use std::os::unix::fs::symlink;
    let mut fixture = Fixture::new("created-normal");
    let mut source: serde_json::Value =
        serde_json::from_slice(&worker_config::encode_config(&fixture.source)).unwrap();
    source["companyRoot"] = json!(fixture.root);
    source["commandTelemetry"] = json!({"enabled":true,"keys":["shell"]});
    fixture.source = worker_config::decode(&serde_json::to_vec(&source).unwrap()).unwrap();
    let (nix, plan, _request, phone) = fixture.resources();
    let telemetry = CommandTelemetry::capture(fixture.runtime(), &fixture.source).unwrap();
    fs::create_dir(fixture.root.join("accounts")).unwrap();
    symlink(
        fixture.root.join("state/command-telemetry"),
        fixture.root.join("accounts/sink"),
    )
    .unwrap();
    let request=WorkerRequest::decode(&serde_json::to_vec(&json!({"sessionId":SID,"cwd":"/workspace","command":"opencode","env":{"CODEX_HOME":"/instances/default/accounts/sink"},"cols":80,"rows":24})).unwrap(),&fixture.source).unwrap();
    let workflow = fixture
        .runtime()
        .retain_laptop_network(&nix, plan, request, phone)
        .unwrap_or_else(|_| panic!("real resources"));
    fixture
        .runtime()
        .run_laptop_network(&workflow, end())
        .unwrap();
    assert!(matches!(
        fixture
            .runtime()
            .create_laptop(&workflow, &telemetry, end())
            .unwrap(),
        LaptopCreation::Rejected
    ));
    assert_eq!(creates(&fixture), 0);
    assert!(!fixture.root.join("created-laptop").exists());
    let returned = fixture
        .runtime()
        .reclaim_laptop_network(workflow)
        .unwrap_or_else(|_| panic!("known boundary refusal"));
    assert!(fixture.close_resources(returned).is_err());
}

fn isolated(name: &str) -> bool {
    crate::test_process::isolate_case(&format!("worker_laptop::tests::create::{name}"))
}
#[test]
fn cancelled_actual_create_retains_owned_effect_after_exact_client_settlement() {
    if isolated("cancelled_actual_create_retains_owned_effect_after_exact_client_settlement") {
        return;
    }
    let fixture = Fixture::new("created-pending");
    let workflow = fixture.retain();
    fixture
        .runtime()
        .run_laptop_network(&workflow, end())
        .unwrap();
    let telemetry =
        Arc::new(CommandTelemetry::capture(fixture.runtime(), &fixture.source).unwrap());
    let runtime = fixture.runtime().clone();
    let selected = workflow.clone();
    let task = std::thread::spawn(move || {
        runtime.create_laptop(
            &selected,
            &telemetry,
            Instant::now() + Duration::from_secs(20),
        )
    });
    let setup = Instant::now() + Duration::from_secs(3);
    while !fixture.root.join("laptop-create-entered").exists() && Instant::now() < setup {
        std::thread::sleep(Duration::from_millis(1));
    }
    let entered = fixture.root.join("laptop-create-entered").exists();
    let first = fixture.runtime().request_stop();
    if !entered {
        fs::write(
            fixture.root.join("release-laptop-create"),
            b"failure-path release",
        )
        .unwrap();
    }
    let result = task.join().unwrap().unwrap();
    fixture
        .runtime()
        .installed_engine()
        .settle_owned(end())
        .unwrap();
    assert!(entered);
    assert!(matches!(result, LaptopCreation::Retained));
    assert!(
        fixture
            .runtime()
            .reclaim_laptop_network(workflow.clone())
            .is_err()
    );
    assert!(fixture.runtime().close(end()).is_err());
    assert_eq!(fixture.runtime().request_stop(), first);
    assert_eq!(creates(&fixture), 1);
    assert!(fixture.root.join("created-laptop").is_file());
    assert!(NixStoreGuard::acquire_migration(&fixture.source, &sid()).is_err());
}
