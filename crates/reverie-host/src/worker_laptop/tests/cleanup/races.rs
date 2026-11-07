//! Terminal transitions over actual same-record concurrent native work.
use super::*;
fn isolate(name: &str) -> bool {
    crate::test_process::isolate_case(&format!("worker_laptop::tests::cleanup::races::{name}"))
}
#[test]
fn unknown_start_is_not_stopped_proof_after_local_client_settlement() {
    if isolate("unknown_start_is_not_stopped_proof_after_local_client_settlement") {
        return;
    }
    let fixture = Fixture::new("created-start-nonzero");
    let (workflow, created) = created(&fixture);
    fixture.runtime().publish_laptop_launch(&created).unwrap();
    assert!(matches!(
        fixture
            .runtime()
            .start_laptop_container(&created, end())
            .unwrap(),
        ContainerStart::Retained
    ));
    fixture
        .runtime()
        .installed_engine()
        .settle_owned(end())
        .unwrap();
    let stopped = matches!(
        fixture
            .runtime()
            .stop_created_laptop(&created, end())
            .unwrap(),
        CreatedCleanup::Stopped(_)
    );
    eprintln!(
        "unknown-start-cleanup-stopped={stopped};actual-calls={:?}",
        calls(&fixture)
    );
    assert!(
        !stopped,
        "local process settlement cannot settle a delayed daemon start"
    );
    assert!(matches!(
        fixture
            .runtime()
            .stop_created_laptop(&created, end())
            .unwrap(),
        CreatedCleanup::Retained
    ));
    assert!(fixture.runtime().publish_laptop_launch(&created).is_err());
    assert!(
        fixture
            .runtime()
            .start_laptop_container(&created, end())
            .is_err()
    );
    assert!(fixture.runtime().reclaim_laptop_network(workflow).is_err());
}
#[test]
fn foreign_runtime_cleanup_cannot_poison_valid_forward_owner() {
    if isolate("foreign_runtime_cleanup_cannot_poison_valid_forward_owner") {
        return;
    }
    let fixture = Fixture::new("created-normal");
    let other = Fixture::new("created-normal");
    let (_, created) = created(&fixture);
    assert!(
        other
            .runtime()
            .stop_created_laptop(&created, end())
            .is_err()
    );
    fixture.runtime().publish_laptop_launch(&created).unwrap();
    assert!(matches!(
        fixture
            .runtime()
            .start_laptop_container(&created, end())
            .unwrap(),
        ContainerStart::Started(_)
    ));
    assert!(!fixture.runtime().cancellation().is_cancelled());
    assert!(matches!(
        fixture
            .runtime()
            .stop_created_laptop(&created, end())
            .unwrap(),
        CreatedCleanup::Stopped(_)
    ));
    assert!(
        fixture
            .runtime()
            .start_laptop_container(&created, end())
            .is_err()
    );
}
#[test]
fn noncanonical_cleanup_request_is_terminal_without_destructive_dispatch() {
    if isolate("noncanonical_cleanup_request_is_terminal_without_destructive_dispatch") {
        return;
    }
    let fixture = Fixture::new("created-noncanonical");
    let (_, created) = created(&fixture);
    assert!(
        fixture
            .runtime()
            .stop_created_laptop(&created, end())
            .is_err()
    );
    assert!(fixture.runtime().publish_laptop_launch(&created).is_err());
    assert!(
        fixture
            .runtime()
            .start_laptop_container(&created, end())
            .is_err()
    );
    assert_eq!(
        calls(&fixture)
            .iter()
            .filter(|args| args[0] == "stop")
            .count(),
        0
    );
}
#[test]
fn in_flight_start_refuses_cleanup_ack_until_same_record_settles() {
    if isolate("in_flight_start_refuses_cleanup_ack_until_same_record_settles") {
        return;
    }
    let fixture = Fixture::new("created-start-pending");
    let (_, created) = created(&fixture);
    fixture.runtime().publish_laptop_launch(&created).unwrap();
    let created = Arc::new(created);
    let selected = created.clone();
    let runtime = fixture.runtime().clone();
    let task = std::thread::spawn(move || {
        runtime.start_laptop_container(&selected, Instant::now() + Duration::from_secs(20))
    });
    let setup = Instant::now() + Duration::from_secs(3);
    while !fixture.root.join("laptop-start-entered").exists() && Instant::now() < setup {
        std::thread::sleep(Duration::from_millis(1));
    }
    let reached = fixture.root.join("laptop-start-entered").exists();
    let premature = fixture.runtime().stop_created_laptop(&created, end());
    fs::write(
        fixture.root.join("release-laptop-start"),
        b"release actual start",
    )
    .unwrap();
    let result = task.join().unwrap();
    assert!(reached);
    assert!(premature.is_err());
    assert!(matches!(result.unwrap(), ContainerStart::Started(_)));
    assert!(matches!(
        fixture
            .runtime()
            .stop_created_laptop(&created, end())
            .unwrap(),
        CreatedCleanup::Stopped(_)
    ));
    assert!(
        fixture
            .runtime()
            .start_laptop_container(&created, end())
            .is_err()
    );
}
#[test]
fn in_flight_publication_finishes_before_terminal_cleanup_and_cannot_restart() {
    if isolate("in_flight_publication_finishes_before_terminal_cleanup_and_cannot_restart") {
        return;
    }
    let fixture = Fixture::new("created-normal");
    let (_, created) = created(&fixture);
    let created = Arc::new(created);
    let selected = created.clone();
    let runtime = fixture.runtime().clone();
    let gate = Arc::new(crate::captured_client::test_hooks::Gate::default());
    let worker_gate = gate.clone();
    let (reached, premature, result) = std::thread::scope(|scope| {
        // Releases before scope joins even if the controlling thread unwinds.
        struct Release(Arc<crate::captured_client::test_hooks::Gate>);
        impl Drop for Release {
            fn drop(&mut self) {
                self.0.released.store(true, Ordering::Release);
            }
        }
        let release = Release(gate.clone());
        let task = scope.spawn(move || {
            super::super::super::publication::test_hooks::hold_after_record_write(worker_gate);
            runtime.publish_laptop_launch(&selected)
        });
        let setup = Instant::now() + Duration::from_secs(3);
        while !gate.entered.load(Ordering::Acquire) && Instant::now() < setup {
            std::thread::sleep(Duration::from_millis(1));
        }
        let reached = gate.entered.load(Ordering::Acquire);
        let premature = fixture.runtime().stop_created_laptop(&created, end());
        drop(release);
        (reached, premature, task.join().unwrap())
    });
    assert!(reached);
    assert!(premature.is_err());
    result.unwrap();
    assert!(!fixture.runtime().cancellation().is_cancelled());
    assert!(matches!(
        fixture
            .runtime()
            .stop_created_laptop(&created, end())
            .unwrap(),
        CreatedCleanup::Stopped(_)
    ));
    assert!(fixture.runtime().publish_laptop_launch(&created).is_err());
    assert!(
        fixture
            .runtime()
            .start_laptop_container(&created, end())
            .is_err()
    );
}
