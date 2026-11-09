use super::*;
use crate::{
    reservation_gate::{AdmissionBounds, tests::Tree},
    test_process::{engine_program, pause_point},
    worker_validation::{load_owner_config, validate_captured},
};
use reverie_host::{
    engine_metadata::{EngineBootstrap, EngineQuery},
    installed_worker_engine::InstalledWorkerEngine,
    worker_runtime::WorkerRuntime,
};
use std::{
    collections::BTreeMap,
    fs, thread,
    time::{Duration, Instant},
};

fn end() -> Instant {
    Instant::now() + Duration::from_secs(10)
}
fn broker(tree: &Tree, executable: &Path) -> Arc<InstallingBroker> {
    let snapshot = load_owner_config(&tree.root.join("worker.json")).unwrap();
    let bootstrap =
        EngineBootstrap::from_service(executable.as_os_str(), BTreeMap::new(), tree.root.clone())
            .unwrap();
    let runtime = WorkerRuntime::new(
        InstalledWorkerEngine::new(bootstrap),
        snapshot.envelope().base(),
    );
    Arc::new(InstallingBroker::new(snapshot, runtime).unwrap())
}
fn controlled(tree: &Tree) -> Arc<InstallingBroker> {
    let binary = tree.root.join("image-refresh");
    fs::hard_link(engine_program(), &binary).unwrap();
    tree.write("ps.out", b"");
    broker(tree, &binary)
}
fn image(snapshot: &ValidatedWorkerSnapshot) -> &str {
    snapshot.envelope().base().image()
}
fn changed(tree: &Tree, letter: char) {
    let mut raw: serde_json::Value = serde_json::from_slice(&tree.raw).unwrap();
    raw["image"] = serde_json::json!(format!("sha256:{}", letter.to_string().repeat(64)));
    tree.write("worker.json", &serde_json::to_vec(&raw).unwrap());
}
fn close(broker: &InstallingBroker) {
    broker.storage.runtime.close(end()).unwrap();
}
fn sid() -> ProfileSessionId {
    ProfileSessionId::parse("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee").unwrap()
}
fn bounds() -> AdmissionBounds {
    AdmissionBounds {
        entry: Some(end()),
        operation: Some(end()),
    }
}
fn wait_file(tree: &Tree, name: &str) {
    let ceiling = end();
    while !tree.root.join(name).exists() {
        assert!(Instant::now() < ceiling, "bounded setup reaches {name}");
        thread::sleep(Duration::from_millis(2));
    }
}
#[test]
fn actual_loader_and_ram_publication_match_thirteen_real_python_handle_prefixes() {
    let oracle: serde_json::Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/launch_image_prefix.json"
    ))
    .unwrap();
    assert_eq!(oracle["cases"].as_array().unwrap().len(), 13);
    for case in oracle["cases"].as_array().unwrap() {
        let tree = Tree::new();
        fs::remove_file(tree.root.join("state/resource-reservation-control.json")).unwrap();
        let text = |field: &str| {
            case[field]
                .as_str()
                .unwrap()
                .replace("$ROOT", tree.root.to_str().unwrap())
        };
        tree.write("worker.json", text("beforeText").as_bytes());
        let service = broker(&tree, &std::env::current_exe().unwrap());
        if case["name"] == "missing-file" {
            fs::remove_file(tree.root.join("worker.json")).unwrap();
        } else {
            tree.write("worker.json", text("updatedText").as_bytes());
        }
        let accepted = service.refresh_launch_configuration().is_ok();
        let current = service.configuration().unwrap();
        close(&service);
        assert_eq!(
            accepted,
            case["entryReached"].as_bool().unwrap(),
            "{}",
            case["name"]
        );
        let expected = worker_config::decode(text("resultingText").as_bytes()).unwrap();
        assert_eq!(
            worker_config::encode_config(current.configuration()),
            worker_config::encode_config(&expected),
            "{}",
            case["name"]
        );
    }
}
#[test]
fn embedded_snapshot_skips_file_loader_and_retains_the_exact_current_owner() {
    let tree = Tree::new();
    let mut raw: serde_json::Value = serde_json::from_slice(&tree.raw).unwrap();
    raw.as_object_mut().unwrap().remove("resourceReservations");
    fs::remove_file(tree.root.join("state/resource-reservation-control.json")).unwrap();
    let snapshot =
        validate_captured(worker_config::decode(&serde_json::to_vec(&raw).unwrap()).unwrap())
            .unwrap();
    let bootstrap = EngineBootstrap::from_service(
        std::env::current_exe().unwrap().as_os_str(),
        BTreeMap::new(),
        tree.root.clone(),
    )
    .unwrap();
    let runtime = WorkerRuntime::new(
        InstalledWorkerEngine::new(bootstrap),
        snapshot.envelope().base(),
    );
    let service = InstallingBroker::new(snapshot, runtime).unwrap();
    fs::remove_file(tree.root.join("worker.json")).unwrap();
    let before = service.configuration().unwrap();
    let after = service.refresh_launch_configuration().unwrap();
    close(&service);
    assert!(Arc::ptr_eq(&before, &after));
    assert!(after.source_path().is_none());
}
#[test]
fn old_entry_capture_adopts_only_the_image_and_keeps_the_original_native_origin_and_bound() {
    crate::test_process::owning_case!(
        old_entry_capture_adopts_only_the_image_and_keeps_the_original_native_origin_and_bound
    );
    let tree = Tree::new();
    let service = controlled(&tree);
    let gate = service.resource_reservations().unwrap().unwrap();
    let (pause, captured, resume) = pause_point();
    gate.pause_next_entry_capture(pause);
    let bound = bounds();
    let owner = service.clone();
    let worker = thread::spawn(move || {
        let gate = owner.resource_reservations().unwrap().unwrap();
        let scope = gate.admit_ordinary_launch(&sid(), bound).unwrap();
        let context = gate.owned_context_for_test().unwrap();
        let deadline = context.deadline(None).unwrap();
        scope.close().unwrap();
        (context, deadline)
    });
    let original = captured.recv_timeout(Duration::from_secs(10)).unwrap();
    changed(&tree, 'b');
    let published = service.refresh_launch_configuration().unwrap();
    resume.send(()).unwrap();
    let (current, deadline) = worker.join().unwrap();
    close(&service);
    assert!(original.same_source_for_test(&current));
    assert_eq!(deadline, bound.operation.unwrap());
    assert_eq!(
        worker_config::encode_config(current.configuration()),
        worker_config::encode_config(published.configuration())
    );
    assert_ne!(
        worker_config::encode_config(original.configuration()),
        worker_config::encode_config(current.configuration())
    );
}
#[test]
fn earlier_full_load_can_win_later_but_disk_ram_mismatch_still_refuses_reserved_entry() {
    crate::test_process::owning_case!(
        earlier_full_load_can_win_later_but_disk_ram_mismatch_still_refuses_reserved_entry
    );
    let tree = Tree::new();
    let service = controlled(&tree);
    changed(&tree, 'b');
    let (pause, captured, resume) = pause_point();
    *service.installed.image_loaded_pause.lock().unwrap() = Some(pause);
    let first = service.clone();
    let worker = thread::spawn(move || first.refresh_launch_configuration().unwrap());
    let earlier = captured.recv_timeout(Duration::from_secs(10)).unwrap();
    changed(&tree, 'c');
    let later = service.refresh_launch_configuration().unwrap();
    resume.send(()).unwrap();
    let winner = worker.join().unwrap();
    let gate = service.resource_reservations().unwrap().unwrap();
    let rejected = gate.admit_ordinary_launch(&sid(), bounds()).err().unwrap();
    service.refresh_launch_configuration().unwrap();
    let scope = gate.admit_ordinary_launch(&sid(), bounds()).unwrap();
    scope.close().unwrap();
    close(&service);
    assert_eq!(image(&winner), image(&earlier));
    assert_ne!(image(&winner), image(&later));
    assert_eq!(rejected.code(), "WORKER_IMAGE_CONFIGURATION_STALE");
}
#[test]
fn image_publication_during_unlocked_preparation_keeps_pending_client_and_original_snapshot() {
    crate::test_process::owning_case!(
        image_publication_during_unlocked_preparation_keeps_pending_client_and_original_snapshot
    );
    let tree = Tree::new();
    let service = controlled(&tree);
    let gate = service.resource_reservations().unwrap().unwrap();
    let scope = gate.admit_ordinary_launch(&sid(), bounds()).unwrap();
    let original = service.configuration().unwrap();
    let original_context = gate.owned_context_for_test().unwrap();
    // Actual launch releases this mutex for native preparation. No Nix success
    // or laptop authority is fabricated by this controlled pending-client case.
    drop(service.installed.lifecycle().unwrap());
    tree.write("hold.next", b"one query");
    let reader = service.storage.runtime.readonly();
    let cancellation = service.storage.runtime.cancellation();
    let query =
        thread::spawn(move || reader.query(EngineQuery::InventoryIds, end(), &cancellation));
    wait_file(&tree, "query-started");
    changed(&tree, 'b');
    let published = service.refresh_launch_configuration().unwrap();
    // This waiter must expire BEFORE the original held query's deadline;
    // waiting for another full query budget would expire the original owner.
    let calls_before_waiter = fs::read(tree.root.join("calls.txt")).unwrap();
    let duplicate = service.storage.runtime.readonly().query(
        EngineQuery::InventoryIds,
        Instant::now() + Duration::from_millis(60),
        &service.storage.runtime.cancellation(),
    );
    let calls_after_waiter = fs::read(tree.root.join("calls.txt")).unwrap();
    tree.write("query-release", b"release actual owned child");
    let original_query = query.join().unwrap();
    let current_context = gate.owned_context_for_test().unwrap();
    scope.close().unwrap();
    close(&service);
    original_query.unwrap();
    let duplicate = duplicate.unwrap_err();
    assert!(!duplicate.is_uncertain(), "waiter started no native call");
    assert_eq!(calls_before_waiter, calls_after_waiter, "no query replay");
    assert_eq!(
        duplicate.fault(),
        reverie_host::engine_metadata::EngineFault::Deadline
    );
    assert!(original_context.same_source_for_test(&current_context));
    assert_eq!(
        original_context.deadline(None).unwrap(),
        current_context.deadline(None).unwrap()
    );
    assert_ne!(image(&original), image(&published));
    assert!(worker_config::image_only_equivalent(
        original.configuration(),
        published.configuration()
    ));
    assert_ne!(
        worker_config::encode_config(original.configuration()),
        worker_config::encode_config(current_context.configuration())
    );
}
