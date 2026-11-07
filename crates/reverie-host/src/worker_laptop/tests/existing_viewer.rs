//! Genuine storage + observed-plan/first-inspect reuse, without Nix, Office
//! phone, Created/Pane/guard tokens or host daemon access.
use super::*;
mod relay;
mod transport;
use crate::{
    worker_launch::ExistingLaptopInspection,
    worker_storage::{LaunchStorage, StorageLease},
};

type Originals = (
    Box<LaunchStorage>,
    ObservedCreatePlan,
    WorkerRequest,
    ExistingLaptopInspection,
);
fn isolated(name: &str) -> bool {
    crate::test_process::isolate_case(&format!("worker_laptop::tests::existing_viewer::{name}"))
}
fn originals(fixture: &Fixture) -> Originals {
    originals_with_id(fixture, "existing-fixture")
}
fn originals_with_id(fixture: &Fixture, id: &str) -> Originals {
    let selection = fixture
        .runtime()
        .resolve_storage(&fixture.source, &sid())
        .unwrap();
    let mut storage =
        if selection.paths().kind() == reverie_store::storage_identity::StorageKind::Session {
            selection.into_legacy().unwrap()
        } else {
            selection.acquire().unwrap()
        };
    storage.prepare_storage().unwrap();
    storage.record_storage_binding().unwrap();
    let plan = fixture
        .runtime()
        .prepare_laptop_plan(fixture.source.clone(), fixture.source.clone(), &storage)
        .unwrap();
    // The controlled engine answers the actual fixed derived-name inspect.
    // This file does not mint the sealed Host observation.
    fs::write(fixture.root.join("started-laptop"), SID).unwrap();
    fs::write(fixture.root.join("existing-inspect.json"),serde_json::to_vec(&json!([{"Config":{"Labels":{"reverie.worker":"fixture","reverie.session":SID}},"State":{"Running":true},"Id":id}])).unwrap()).unwrap();
    let inspected = plan
        .inspect_existing(fixture.runtime(), end())
        .unwrap()
        .unwrap();
    let request=WorkerRequest::decode(&serde_json::to_vec(&json!({"sessionId":SID,"cwd":"/workspace","command":"opencode","env":{},"cols":80,"rows":24})).unwrap(),&fixture.source).unwrap();
    (Box::new(storage), plan, request, inspected)
}
fn retain(fixture: &Fixture, originals: Originals) -> ExistingViewer {
    let (storage, plan, request, inspected) = originals;
    fixture
        .runtime()
        .retain_existing_viewer(storage, plan, request, inspected)
        .unwrap_or_else(|failure| panic!("retain: {}", failure.cause()))
}
fn start(fixture: &Fixture, existing: &ExistingViewer) -> ViewerSession {
    let ExistingViewerStart::Started(viewer) = fixture
        .runtime()
        .start_existing_viewer(existing, end())
        .unwrap()
    else {
        panic!("actual existing attach")
    };
    wait(|| fixture.root.join("viewer-ready").is_file());
    viewer
}
fn wait(mut ready: impl FnMut() -> bool) {
    let end = end();
    while !ready() {
        assert!(Instant::now() < end, "owned fixture bound");
        std::thread::sleep(Duration::from_millis(1));
    }
}
fn restore(fixture: &Fixture, existing: &ExistingViewer) -> Box<LaunchStorage> {
    let (storage, _plan, _request, _inspected, _failure) = fixture
        .runtime()
        .reclaim_existing_viewer(existing)
        .unwrap()
        .into_parts();
    storage
}
#[test]
fn actual_existing_attach_returns_same_employee_box_once_without_nix_or_office() {
    if isolated("actual_existing_attach_returns_same_employee_box_once_without_nix_or_office") {
        return;
    }
    let fixture = Fixture::employee("created-viewer-echo");
    let originals = originals(&fixture);
    let address = (&*originals.0) as *const LaunchStorage;
    let existing = retain(&fixture, originals);
    let viewer = start(&fixture, &existing);
    assert!(viewer.same_existing(&existing));
    fixture
        .runtime()
        .write_laptop_viewer(&viewer, b"echo")
        .unwrap();
    let mut bytes = Vec::new();
    wait(|| {
        let mut buffer = [0; 32];
        match fixture.runtime().read_laptop_viewer(&viewer, &mut buffer) {
            Ok(n) => bytes.extend_from_slice(&buffer[..n]),
            Err(LaptopError::Io(error)) if error.kind() == std::io::ErrorKind::WouldBlock => {}
            other => panic!("read: {other:?}"),
        }
        bytes == b"echo"
    });
    assert!(
        fixture
            .runtime()
            .reclaim_existing_viewer(&existing)
            .is_err()
    );
    fixture
        .runtime()
        .close_existing_viewer(&existing, end())
        .unwrap();
    assert!(
        fixture.runtime().settle_owned(end()).is_err(),
        "native viewer cleanup cannot release its still-held storage"
    );
    assert!(
        fixture
            .runtime()
            .write_laptop_viewer(&viewer, b"later")
            .is_err()
    );
    assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
    let storage = restore(&fixture, &existing);
    assert!(std::ptr::eq(&*storage, address));
    assert!(
        fixture
            .runtime()
            .reclaim_existing_viewer(&existing)
            .is_err()
    );
    assert!(
        fixture
            .runtime()
            .close_laptop_viewer(&viewer, end())
            .is_err()
    );
    let trace = fs::read_to_string(fixture.root.join("trace")).unwrap();
    assert!(!trace.lines().any(|v| v.starts_with("create\0")
        || v.starts_with("network\0")
        || v.starts_with("image\0")));
    assert!(
        !fixture.root.join("api").exists(),
        "no Office phone for reuse"
    );
    storage.close(end()).unwrap();
    StorageLease::acquire_migration(&fixture.source, &sid())
        .unwrap()
        .close()
        .unwrap();
}
#[test]
fn dropped_return_guard_keeps_same_slot_and_actual_lease_until_atomic_restore() {
    if isolated("dropped_return_guard_keeps_same_slot_and_actual_lease_until_atomic_restore") {
        return;
    }
    let fixture = Fixture::employee("created-viewer-echo");
    let existing = retain(&fixture, originals(&fixture));
    drop(
        fixture
            .runtime()
            .reclaim_existing_viewer(&existing)
            .unwrap(),
    );
    assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
    assert_eq!(
        fixture
            .runtime()
            .laptop_workflows()
            .records
            .lock()
            .unwrap()
            .len(),
        1
    );
    fixture
        .runtime()
        .close_existing_viewer(&existing, end())
        .unwrap();
    assert!(
        fixture
            .runtime()
            .start_existing_viewer(&existing, end())
            .is_err()
    );
    assert!(!fixture.root.join("viewer-ready").exists());
    let storage = restore(&fixture, &existing);
    assert!(
        fixture
            .runtime()
            .laptop_workflows()
            .records
            .lock()
            .unwrap()
            .is_empty()
    );
    storage.close(end()).unwrap();
}
#[test]
fn foreign_runtime_and_different_plan_observation_return_every_original_before_attach() {
    if isolated(
        "foreign_runtime_and_different_plan_observation_return_every_original_before_attach",
    ) {
        return;
    }
    let fixture = Fixture::employee("created-viewer-echo");
    let other = Fixture::new("created-viewer-echo");
    let (storage, plan, request, inspected) = originals(&fixture);
    let address = (&*storage) as *const LaunchStorage;
    let failure = other
        .runtime()
        .retain_existing_viewer(storage, plan, request, inspected)
        .err()
        .unwrap();
    let (storage, _plan, request, inspected, _cause) = failure.into_parts();
    assert!(std::ptr::eq(&*storage, address));
    let different = fixture
        .runtime()
        .prepare_laptop_plan(fixture.source.clone(), fixture.source.clone(), &storage)
        .unwrap();
    let failure = fixture
        .runtime()
        .retain_existing_viewer(storage, different, request, inspected)
        .err()
        .unwrap();
    let (storage, plan, request, _old, _cause) = failure.into_parts();
    assert!(std::ptr::eq(&*storage, address));
    let inspected = plan
        .inspect_existing(fixture.runtime(), end())
        .unwrap()
        .unwrap();
    let existing = retain(&fixture, (storage, plan, request, inspected));
    assert!(
        other
            .runtime()
            .start_existing_viewer(&existing, end())
            .is_err()
    );
    assert!(!fixture.root.join("viewer-ready").exists());
    assert!(!other.root.join("viewer-ready").exists());
    restore(&fixture, &existing).close(end()).unwrap();
}
#[test]
fn actual_consumed_close_uncertainty_retains_employee_box_and_origin_without_retry() {
    if isolated("actual_consumed_close_uncertainty_retains_employee_box_and_origin_without_retry") {
        return;
    }
    let fixture = Fixture::employee("created-viewer-echo");
    let existing = retain(&fixture, originals(&fixture));
    super::super::viewer::test_hooks::refuse_next_input_close();
    assert!(matches!(
        fixture
            .runtime()
            .start_existing_viewer(&existing, end())
            .unwrap(),
        ExistingViewerStart::Retained
    ));
    assert!(
        fixture
            .runtime()
            .close_existing_viewer(&existing, end())
            .is_err()
    );
    assert!(
        fixture
            .runtime()
            .close_existing_viewer(&existing, end())
            .is_err()
    );
    assert!(
        fixture
            .runtime()
            .reclaim_existing_viewer(&existing)
            .is_err()
    );
    assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
    assert!(fixture.runtime().close(end()).is_err());
    let origin = Arc::downgrade(fixture.runtime().installed_engine());
    drop(existing);
    drop(fixture);
    assert!(
        origin.upgrade().is_some(),
        "same real engine kept by actual quarantined record"
    );
}
#[test]
fn existing_and_created_owners_share_one_actual_capacity_and_restore_reuses_only_its_slot() {
    if isolated(
        "existing_and_created_owners_share_one_actual_capacity_and_restore_reuses_only_its_slot",
    ) {
        return;
    }
    let fixture = Fixture::new("created-viewer-echo");
    let created = fixture.retain();
    assert_eq!(
        fixture
            .runtime()
            .run_laptop_network(&created, end())
            .unwrap(),
        LaptopNetworkProgress::Ready
    );
    let mut existing = Vec::new();
    for _ in 1..fixture.runtime().connection_limit() {
        existing.push(retain(&fixture, originals(&fixture)));
    }
    let (storage, plan, request, inspected) = originals(&fixture);
    let address = (&*storage) as *const LaunchStorage;
    let failure = fixture
        .runtime()
        .retain_existing_viewer(storage, plan, request, inspected)
        .err()
        .expect("one shared captured capacity");
    assert_eq!(failure.cause().code(), "WORKER_LAPTOP_CAPACITY");
    let (storage, plan, request, inspected, _) = failure.into_parts();
    assert!(std::ptr::eq(&*storage, address));
    let removed = existing.pop().unwrap();
    restore(&fixture, &removed).close(end()).unwrap();
    let replacement = retain(&fixture, (storage, plan, request, inspected));
    assert!(!replacement.same_owner(&removed));
    assert!(
        fixture
            .runtime()
            .start_existing_viewer(&removed, end())
            .is_err()
    );
    restore(&fixture, &replacement).close(end()).unwrap();
    for record in existing {
        restore(&fixture, &record).close(end()).unwrap();
    }
    fixture
        .close_resources(
            fixture
                .runtime()
                .reclaim_laptop_network(created)
                .unwrap_or_else(|_| panic!("same known network")),
        )
        .unwrap();
    assert!(
        fixture
            .runtime()
            .laptop_workflows()
            .records
            .lock()
            .unwrap()
            .is_empty()
    );
    assert!(!fixture.root.join("viewer-ready").exists());
}
#[test]
fn returned_originals_admit_new_record_but_stale_viewer_cannot_close_its_actual_child() {
    if isolated(
        "returned_originals_admit_new_record_but_stale_viewer_cannot_close_its_actual_child",
    ) {
        return;
    }
    let fixture = Fixture::employee("created-viewer-echo");
    let old = retain(&fixture, originals(&fixture));
    let stale = start(&fixture, &old);
    fixture
        .runtime()
        .close_existing_viewer(&old, end())
        .unwrap();
    let (storage, plan, request, inspected, _) = fixture
        .runtime()
        .reclaim_existing_viewer(&old)
        .unwrap()
        .into_parts();
    fs::remove_file(fixture.root.join("viewer-ready")).unwrap();
    let new = retain(&fixture, (storage, plan, request, inspected));
    let live = start(&fixture, &new);
    assert!(!old.same_owner(&new));
    assert!(!stale.same_existing(&new));
    assert!(
        fixture
            .runtime()
            .close_laptop_viewer(&stale, end())
            .is_err()
    );
    assert!(
        fixture
            .runtime()
            .close_existing_viewer(&old, end())
            .is_err()
    );
    assert_eq!(fixture.runtime().laptop_viewer_status(&live).unwrap(), None);
    fixture
        .runtime()
        .close_existing_viewer(&new, end())
        .unwrap();
    restore(&fixture, &new).close(end()).unwrap();
}
#[test]
fn late_existing_constructor_stays_with_original_box_until_checked_cleanup() {
    if isolated("late_existing_constructor_stays_with_original_box_until_checked_cleanup") {
        return;
    }
    use std::sync::atomic::Ordering;
    let fixture = Fixture::employee("created-viewer-echo");
    let existing = retain(&fixture, originals(&fixture));
    let gate = Arc::new(crate::captured_client::test_hooks::Gate::default());
    struct Release(Arc<crate::captured_client::test_hooks::Gate>);
    impl Drop for Release {
        fn drop(&mut self) {
            self.0.released.store(true, Ordering::Release);
        }
    }
    let _release = Release(gate.clone());
    std::thread::scope(|scope| {
        let runtime = fixture.runtime();
        let existing = &existing;
        let gate = gate.clone();
        let entering = gate.clone();
        let constructor = scope.spawn(move || {
            super::super::viewer::test_hooks::next_constructor(gate);
            runtime.start_existing_viewer(existing, end())
        });
        wait(|| entering.entered.load(Ordering::Acquire));
        assert!(fixture.runtime().reclaim_existing_viewer(existing).is_err());
        fixture.runtime().request_stop();
        assert!(matches!(
            constructor.join().unwrap().unwrap(),
            ExistingViewerStart::Retained
        ));
    });
    assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
    assert!(
        fixture
            .runtime()
            .reclaim_existing_viewer(&existing)
            .is_err()
    );
    gate.released.store(true, Ordering::Release);
    fixture
        .runtime()
        .close_existing_viewer(&existing, end())
        .unwrap();
    restore(&fixture, &existing).close(end()).unwrap();
}
#[test]
fn actual_existing_io_holds_same_record_against_close_and_resource_return() {
    if isolated("actual_existing_io_holds_same_record_against_close_and_resource_return") {
        return;
    }
    use std::sync::atomic::Ordering;
    let fixture = Fixture::employee("created-viewer-echo");
    let existing = retain(&fixture, originals(&fixture));
    let viewer = start(&fixture, &existing);
    let gate = Arc::new(crate::captured_client::test_hooks::Gate::default());
    struct Release(Arc<crate::captured_client::test_hooks::Gate>);
    impl Drop for Release {
        fn drop(&mut self) {
            self.0.released.store(true, Ordering::Release);
        }
    }
    let _release = Release(gate.clone());
    std::thread::scope(|scope| {
        let runtime = fixture.runtime();
        let viewer = &viewer;
        let blocked = gate.clone();
        let write = scope.spawn(move || {
            super::super::viewer::test_hooks::next_write(blocked);
            runtime.write_laptop_viewer(viewer, b"held")
        });
        wait(|| gate.entered.load(Ordering::Acquire));
        assert!(
            fixture
                .runtime()
                .close_existing_viewer(&existing, end())
                .is_err()
        );
        assert!(
            fixture
                .runtime()
                .reclaim_existing_viewer(&existing)
                .is_err()
        );
        assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
        gate.released.store(true, Ordering::Release);
        assert_eq!(write.join().unwrap().unwrap(), 4);
    });
    fixture
        .runtime()
        .close_existing_viewer(&existing, end())
        .unwrap();
    restore(&fixture, &existing).close(end()).unwrap();
}
