//! Actual fixed engine clients over the genuine create -> publication -> start
//! -> absent-memory -> no-retention cold chain. No stage/token is fabricated.
use super::*;
fn cold(fixture: &Fixture) -> (LaptopWorkflow, CreatedLaptop, ColdCommitted) {
    let (workflow, created) = super::publication::created(fixture);
    fixture.runtime().publish_laptop_launch(&created).unwrap();
    let ContainerStart::Started(started) = fixture
        .runtime()
        .start_laptop_container(&created, end())
        .unwrap()
    else {
        panic!("actual started record")
    };
    let MemoryConfiguration::Configured(memory) = fixture
        .runtime()
        .configure_started_laptop_memory(&started, end())
        .unwrap()
    else {
        panic!("actual absent-memory phase")
    };
    let ColdCommit::Committed(cold) = fixture
        .runtime()
        .commit_started_laptop_cold(&memory, end())
        .unwrap()
    else {
        panic!("actual no-retention cold phase")
    };
    (workflow, created, cold)
}
fn calls(fixture: &Fixture) -> Vec<Vec<String>> {
    fs::read_to_string(fixture.root.join("trace"))
        .unwrap_or_default()
        .lines()
        .map(|line| line.split('\0').map(str::to_owned).collect())
        .collect()
}
fn execs(fixture: &Fixture) -> Vec<Vec<String>> {
    calls(fixture)
        .into_iter()
        .filter(|args| args.first().is_some_and(|arg| arg == "exec"))
        .collect()
}
fn isolated(name: &str) -> bool {
    crate::test_process::isolate_case(&format!("worker_laptop::tests::pane::{name}"))
}
#[test]
fn exact_native_pane_and_status_order_uses_actual_published_nonce_without_shell() {
    if isolated("exact_native_pane_and_status_order_uses_actual_published_nonce_without_shell") {
        return;
    }
    for mode in ["created-pane-normal", "created-noncanonical"] {
        let fixture = Fixture::new(mode);
        let (workflow, _created, cold) = cold(&fixture);
        let PaneStart::Started(pane) = fixture.runtime().start_laptop_pane(&cold, end()).unwrap()
        else {
            panic!("both actual native commands acknowledged")
        };
        assert!(pane.same_workflow(&workflow));
        let trace = execs(&fixture);
        assert_eq!(trace.len(), 2);
        let record = workflow.record.lock().unwrap();
        assert_eq!(
            record.creation.as_ref().unwrap().container.is_some(),
            mode != "created-noncanonical"
        );
        let resources = record.resources();
        let name = reverie_core::worker_launch::ContainerReference::Worker(
            resources.plan.arguments().worker_name(),
        );
        let nonce = record
            .creation
            .as_ref()
            .unwrap()
            .publication
            .as_ref()
            .unwrap()
            .nonce();
        let scalar = |args: Vec<reverie_contracts::storage_identity::MetadataText>| {
            args.into_iter()
                .map(|arg| arg.scalar_text().unwrap())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            trace[0],
            scalar(reverie_contracts::worker_launch::pane_start_arguments(
                &name,
                nonce,
                resources.request.terminal()
            ))
        );
        assert_eq!(
            trace[1],
            scalar(reverie_contracts::worker_launch::pane_status_arguments(
                &name
            ))
        );
        assert!(trace[0].iter().any(|arg| arg == "--pane-exit"));
        assert!(
            !trace
                .iter()
                .flatten()
                .any(|arg| matches!(arg.as_str(), "/bin/bash" | "-c"))
        );
        drop(record);
        assert!(fixture.runtime().start_laptop_pane(&cold, end()).is_err());
        assert_eq!(execs(&fixture), trace);
        assert!(fixture.runtime().reclaim_laptop_network(workflow).is_err());
        assert!(fixture.runtime().close(end()).is_err());
    }
}
#[test]
fn wrong_runtime_refuses_before_consuming_valid_pane_phase() {
    if isolated("wrong_runtime_refuses_before_consuming_valid_pane_phase") {
        return;
    }
    let fixture = Fixture::new("created-pane-normal");
    let other = Fixture::new("created-pane-normal");
    let (workflow, _created, cold) = cold(&fixture);
    assert!(other.runtime().start_laptop_pane(&cold, end()).is_err());
    assert!(execs(&fixture).is_empty() && execs(&other).is_empty());
    assert!(matches!(
        fixture.runtime().start_laptop_pane(&cold, end()).unwrap(),
        PaneStart::Started(_)
    ));
    assert!(cold.same_workflow(&workflow));
}
#[test]
fn known_cleanup_is_terminal_for_pane_without_global_stop() {
    if isolated("known_cleanup_is_terminal_for_pane_without_global_stop") {
        return;
    }
    let fixture = Fixture::new("created-pane-normal");
    let (_workflow, created, cold) = cold(&fixture);
    assert!(!fixture.runtime().cancellation().is_cancelled());
    assert!(matches!(
        fixture
            .runtime()
            .stop_created_laptop(&created, end())
            .unwrap(),
        CreatedCleanup::Stopped(_)
    ));
    assert!(fixture.runtime().start_laptop_pane(&cold, end()).is_err());
    assert!(execs(&fixture).is_empty());
    assert!(!fixture.runtime().cancellation().is_cancelled());
}
#[test]
fn expired_caller_and_global_cancellation_refuse_before_any_tmux_client() {
    if isolated("expired_caller_and_global_cancellation_refuse_before_any_tmux_client") {
        return;
    }
    for cancelled in [false, true] {
        let fixture = Fixture::new("created-pane-normal");
        let (_workflow, _created, cold) = cold(&fixture);
        let deadline = if cancelled {
            fixture.runtime().request_stop();
            end()
        } else {
            Instant::now()
        };
        assert!(matches!(
            fixture
                .runtime()
                .start_laptop_pane(&cold, deadline)
                .unwrap(),
            PaneStart::Rejected
        ));
        assert!(execs(&fixture).is_empty());
        assert!(fixture.runtime().start_laptop_pane(&cold, end()).is_err());
    }
}
#[test]
fn nonzero_and_encoding_failures_keep_real_pane_side_effect_and_never_replay() {
    if isolated("nonzero_and_encoding_failures_keep_real_pane_side_effect_and_never_replay") {
        return;
    }
    for (mode, count) in [
        ("created-pane-start-nonzero", 1),
        ("created-pane-status-nonzero", 2),
        ("created-pane-start-bad-utf8", 1),
        ("created-pane-status-bad-utf8", 2),
    ] {
        let fixture = Fixture::new(mode);
        let (workflow, created, cold) = cold(&fixture);
        assert!(matches!(
            fixture.runtime().start_laptop_pane(&cold, end()).unwrap(),
            PaneStart::Retained
        ));
        fixture
            .runtime()
            .installed_engine()
            .settle_owned(end())
            .unwrap();
        assert!(fixture.root.join("pane-created").is_file());
        assert!(fixture.runtime().start_laptop_pane(&cold, end()).is_err());
        assert_eq!(execs(&fixture).len(), count);
        assert!(matches!(
            fixture
                .runtime()
                .stop_created_laptop(&created, end())
                .unwrap(),
            CreatedCleanup::Retained
        ));
        assert!(fixture.runtime().reclaim_laptop_network(workflow).is_err());
        assert!(NixStoreGuard::acquire_migration(&fixture.source, &sid()).is_err());
    }
}
#[test]
fn in_flight_status_excludes_cleanup_and_second_pane_then_cleanup_fences_token() {
    if isolated("in_flight_status_excludes_cleanup_and_second_pane_then_cleanup_fences_token") {
        return;
    }
    let fixture = Fixture::new("created-pane-status-pending");
    let (_workflow, created, cold) = cold(&fixture);
    std::thread::scope(|scope| {
        let source = &fixture;
        let token = &cold;
        let task = scope.spawn(move || {
            source
                .runtime()
                .start_laptop_pane(token, Instant::now() + Duration::from_secs(10))
        });
        let until = Instant::now() + Duration::from_secs(3);
        while !fixture.root.join("pane-entered").exists() {
            assert!(Instant::now() < until, "actual status client admission");
            std::thread::sleep(Duration::from_millis(1));
        }
        assert!(fixture.root.join("pane-created").is_file());
        let refused_cleanup = fixture
            .runtime()
            .stop_created_laptop(&created, end())
            .is_err();
        let refused_second = fixture.runtime().start_laptop_pane(&cold, end()).is_err();
        fs::write(
            fixture.root.join("release-pane"),
            b"release actual status client",
        )
        .unwrap();
        let result = task.join().unwrap().unwrap();
        assert!(refused_cleanup && refused_second);
        assert!(matches!(result, PaneStart::Started(_)));
    });
    assert!(matches!(
        fixture
            .runtime()
            .stop_created_laptop(&created, end())
            .unwrap(),
        CreatedCleanup::Stopped(_)
    ));
    assert!(fixture.runtime().start_laptop_pane(&cold, end()).is_err());
    assert_eq!(execs(&fixture).len(), 2);
}
#[test]
fn actual_status_timeout_retains_effect_after_local_constructor_settlement() {
    if isolated("actual_status_timeout_retains_effect_after_local_constructor_settlement") {
        return;
    }
    let fixture = Fixture::new("created-pane-status-pending");
    let (workflow, created, cold) = cold(&fixture);
    std::thread::scope(|scope| {
        let source = &fixture;
        let token = &cold;
        let task = scope.spawn(move || {
            source
                .runtime()
                .start_laptop_pane(token, Instant::now() + Duration::from_secs(5))
        });
        let setup = Instant::now() + Duration::from_secs(3);
        while !fixture.root.join("pane-entered").exists() {
            assert!(
                Instant::now() < setup,
                "actual status constructor entered before original ceiling"
            );
            std::thread::sleep(Duration::from_millis(1));
        }
        let result = task.join().unwrap().unwrap();
        assert!(matches!(result, PaneStart::Retained));
    });
    assert!(!fixture.runtime().cancellation().is_cancelled());
    fixture
        .runtime()
        .installed_engine()
        .settle_owned(end())
        .unwrap();
    assert!(fixture.root.join("pane-created").is_file());
    assert!(fixture.runtime().start_laptop_pane(&cold, end()).is_err());
    assert_eq!(execs(&fixture).len(), 2);
    assert!(matches!(
        fixture
            .runtime()
            .stop_created_laptop(&created, end())
            .unwrap(),
        CreatedCleanup::Retained
    ));
    assert!(fixture.runtime().reclaim_laptop_network(workflow).is_err());
}
