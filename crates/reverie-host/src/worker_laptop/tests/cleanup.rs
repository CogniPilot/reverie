mod races;
use super::*;
use crate::command_telemetry::CommandTelemetry;
fn created(fixture: &Fixture) -> (LaptopWorkflow, CreatedLaptop) {
    let workflow = fixture.retain();
    fixture
        .runtime()
        .run_laptop_network(&workflow, end())
        .unwrap();
    let telemetry = CommandTelemetry::capture(fixture.runtime(), &fixture.source).unwrap();
    let LaptopCreation::Created(created) = fixture
        .runtime()
        .create_laptop(&workflow, &telemetry, end())
        .unwrap()
    else {
        panic!("actual create");
    };
    (workflow, created)
}
fn calls(fixture: &Fixture) -> Vec<Vec<String>> {
    fs::read_to_string(fixture.root.join("trace"))
        .unwrap()
        .lines()
        .map(|line| line.split('\0').map(str::to_owned).collect())
        .collect()
}
fn isolated(name: &str) -> bool {
    crate::test_process::isolate_case(&format!("worker_laptop::tests::cleanup::{name}"))
}
#[test]
fn immutable_created_target_cleanup_never_signals_recycled_name_and_keeps_resource_owners() {
    if isolated(
        "immutable_created_target_cleanup_never_signals_recycled_name_and_keeps_resource_owners",
    ) {
        return;
    }
    for mode in ["created-normal", "created-cleanup-kill"] {
        let fixture = Fixture::new(mode);
        let (workflow, created) = created(&fixture);
        fs::write(
            fixture.root.join("foreign-recycled-name"),
            b"foreign untouched",
        )
        .unwrap();
        let first = fixture.runtime().request_stop();
        let CreatedCleanup::Stopped(stopped) = fixture
            .runtime()
            .stop_created_laptop(&created, end())
            .unwrap()
        else {
            panic!("known stopped immutable CID");
        };
        assert!(stopped.same_workflow(&workflow));
        assert!(matches!(
            fixture
                .runtime()
                .stop_created_laptop(&created, end())
                .unwrap(),
            CreatedCleanup::Stopped(_)
        ));
        let trace = calls(&fixture);
        let cleanup = trace
            .iter()
            .filter(|args| matches!(args[0].as_str(), "stop" | "inspect" | "kill"))
            .collect::<Vec<_>>();
        let cid = "c".repeat(64);
        let mut expected = vec![
            vec![
                "stop".to_owned(),
                "--time".to_owned(),
                "2".to_owned(),
                cid.clone(),
            ],
            vec!["inspect".to_owned(), cid.clone()],
        ];
        if mode == "created-cleanup-kill" {
            expected.extend([
                vec!["kill".to_owned(), cid.clone()],
                vec!["inspect".to_owned(), cid],
            ]);
        }
        assert_eq!(
            cleanup.iter().map(|row| (*row).clone()).collect::<Vec<_>>(),
            expected
        );
        assert_eq!(
            fs::read(fixture.root.join("foreign-recycled-name")).unwrap(),
            b"foreign untouched"
        );
        assert_eq!(fixture.runtime().request_stop(), first);
        assert!(fixture.runtime().reclaim_laptop_network(workflow).is_err());
        assert!(
            fixture.runtime().close(end()).is_err(),
            "local stopped phase is no resource/global close ACK"
        );
        assert!(NixStoreGuard::acquire_migration(&fixture.source, &sid()).is_err());
    }
}
#[test]
fn failed_inspect_mismatched_identity_and_lost_reply_never_ack_or_retry_cleanup() {
    if isolated("failed_inspect_mismatched_identity_and_lost_reply_never_ack_or_retry_cleanup") {
        return;
    }
    for mode in [
        "created-inspect-missing",
        "created-inspect-mismatch",
        "created-stop-bad-utf8",
    ] {
        let fixture = Fixture::new(mode);
        let (workflow, created) = created(&fixture);
        assert!(matches!(
            fixture
                .runtime()
                .stop_created_laptop(&created, end())
                .unwrap(),
            CreatedCleanup::Retained
        ));
        fixture
            .runtime()
            .installed_engine()
            .settle_owned(end())
            .unwrap();
        assert!(created.cleanup_failure().unwrap().is_some());
        assert!(matches!(
            fixture
                .runtime()
                .stop_created_laptop(&created, end())
                .unwrap(),
            CreatedCleanup::Retained
        ));
        assert_eq!(
            calls(&fixture)
                .iter()
                .filter(|args| args[0] == "stop")
                .count(),
            1
        );
        assert!(fixture.runtime().reclaim_laptop_network(workflow).is_err());
        assert!(fixture.runtime().close(end()).is_err());
        assert!(fixture.root.join("stopped-laptop").is_file());
    }
}
#[test]
fn noncanonical_created_name_cannot_mint_destructive_cleanup_or_resource_credit() {
    if isolated("noncanonical_created_name_cannot_mint_destructive_cleanup_or_resource_credit") {
        return;
    }
    let fixture = Fixture::new("created-noncanonical");
    let (workflow, created) = created(&fixture);
    assert!(
        fixture
            .runtime()
            .stop_created_laptop(&created, end())
            .is_err()
    );
    assert_eq!(
        calls(&fixture)
            .iter()
            .filter(|args| args[0] == "stop")
            .count(),
        0
    );
    assert!(fixture.runtime().reclaim_laptop_network(workflow).is_err());
    assert!(fixture.runtime().close(end()).is_err());
}
#[test]
fn original_expired_cleanup_end_does_not_become_fresh_budget_or_dispatch() {
    if isolated("original_expired_cleanup_end_does_not_become_fresh_budget_or_dispatch") {
        return;
    }
    let fixture = Fixture::new("created-normal");
    let (_workflow, created) = created(&fixture);
    let first = fixture.runtime().request_stop();
    assert!(matches!(
        fixture
            .runtime()
            .stop_created_laptop(&created, Instant::now())
            .unwrap(),
        CreatedCleanup::Retained
    ));
    assert!(matches!(
        fixture
            .runtime()
            .stop_created_laptop(&created, end())
            .unwrap(),
        CreatedCleanup::Retained
    ));
    assert_eq!(fixture.runtime().request_stop(), first);
    assert_eq!(
        calls(&fixture)
            .iter()
            .filter(|args| args[0] == "stop")
            .count(),
        0
    );
}

#[test]
fn cleanup_is_terminal_without_global_stop_before_or_after_publication() {
    if isolated("cleanup_is_terminal_without_global_stop_before_or_after_publication") {
        return;
    }
    let mut traces = Vec::new();
    for publish_first in [true, false] {
        let fixture = Fixture::new("created-normal");
        let (workflow, created) = created(&fixture);
        if publish_first {
            fixture.runtime().publish_laptop_launch(&created).unwrap();
        }
        assert!(!fixture.runtime().cancellation().is_cancelled());
        assert!(matches!(
            fixture
                .runtime()
                .stop_created_laptop(&created, end())
                .unwrap(),
            CreatedCleanup::Stopped(_)
        ));
        let published_late =
            !publish_first && fixture.runtime().publish_laptop_launch(&created).is_ok();
        let started_late = matches!(
            fixture.runtime().start_laptop_container(&created, end()),
            Ok(ContainerStart::Started(_))
        );
        let repeated_stopped = matches!(
            fixture
                .runtime()
                .stop_created_laptop(&created, end())
                .unwrap(),
            CreatedCleanup::Stopped(_)
        );
        let trace = calls(&fixture);
        traces.push(json!({"publishedBeforeCleanup":publish_first,"publishedAfterCleanup":published_late,"startedAfterCleanup":started_late,"repeatedStopped":repeated_stopped,"startedFile":fixture.root.join("started-laptop").is_file(),"calls":trace}));
        assert!(fixture.runtime().reclaim_laptop_network(workflow).is_err());
    }
    eprintln!(
        "terminal-cleanup-owning-traces={}",
        serde_json::to_string(&traces).unwrap()
    );
    assert!(
        traces
            .iter()
            .all(|case| case["publishedAfterCleanup"] == false
                && case["startedAfterCleanup"] == false),
        "stopped cleanup must prohibit later forward phases without global stop"
    );
}
