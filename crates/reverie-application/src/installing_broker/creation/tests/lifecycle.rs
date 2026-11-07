//! Real held broker mutex and fixed engine subprocess; no modeled lock owner.
use super::*;
use crate::{reservation_gate::tests::Tree, worker_validation::load_owner_config};
use reverie_host::{
    engine_metadata::EngineBootstrap, installed_worker_engine::InstalledWorkerEngine,
};
use std::{collections::BTreeMap, fs, sync::mpsc};

fn broker(tree: &Tree) -> Arc<InstallingBroker> {
    let mut raw: Value = serde_json::from_slice(&tree.raw).unwrap();
    raw.as_object_mut().unwrap().remove("resourceReservations");
    tree.write("worker.json", &serde_json::to_vec(&raw).unwrap());
    tree.write("company.json", br#"{"employees":[]}"#);
    tree.write("names.out", b"");
    fs::remove_file(tree.root.join("state/resource-reservation-control.json")).unwrap();
    let snapshot = load_owner_config(&tree.root.join("worker.json")).unwrap();
    let bootstrap = EngineBootstrap::from_service(
        crate::installing_broker::recovered::tests::program().as_os_str(),
        BTreeMap::new(),
        tree.root.clone(),
    )
    .unwrap();
    let runtime = WorkerRuntime::new(
        InstalledWorkerEngine::new(bootstrap),
        snapshot.envelope().base(),
    );
    Arc::new(InstallingBroker::new(snapshot, runtime).unwrap())
}
fn resources(tree: &Tree) -> EffectiveWorkerConfig {
    let mut raw: Value = serde_json::from_slice(&tree.raw).unwrap();
    raw["budgetMode"] = json!("admission");
    raw["memoryMiB"] = json!(512);
    worker_config::decode(&serde_json::to_vec(&raw).unwrap()).unwrap()
}
fn session() -> ProfileSessionId {
    ProfileSessionId::parse("11111111-2222-4333-8444-555555555555").unwrap()
}
fn end() -> Instant {
    Instant::now() + Duration::from_secs(3)
}
#[test]
fn actual_creation_query_reuses_the_held_lifecycle_without_unlocking_or_relocking() {
    crate::test_process::owning_case!(
        actual_creation_query_reuses_the_held_lifecycle_without_unlocking_or_relocking
    );
    let tree = Tree::new();
    let broker = broker(&tree);
    let candidate = resources(&tree);
    let worker = broker.clone();
    let (finished, outcome) = mpsc::sync_channel(1);
    let task = std::thread::spawn(move || {
        let lifecycle = worker.installed.lifecycle().unwrap();
        let result = worker
            .check_creation_budget_locked(&lifecycle, &session(), &candidate, None)
            .map_err(|error| error.code());
        let still_held = worker.installed.laptops.try_lock().is_err();
        drop(lifecycle);
        finished.send((result, still_held)).unwrap();
    });
    let (result, still_held) = outcome
        .recv_timeout(Duration::from_secs(5))
        .expect("actual held-lock budget call must finish, not wait on its own mutex");
    task.join().unwrap();
    result.unwrap();
    assert!(
        still_held,
        "the original lifecycle guard survived native I/O"
    );
    let trace = fs::read_to_string(tree.root.join("calls.txt")).unwrap();
    assert_eq!(
        trace,
        "ps\0--filter\0label=reverie.worker=test\0--format\0{{.Names}}\n"
    );
    broker.close_command_telemetry(end()).unwrap();
    broker.storage.runtime.close(end()).unwrap();
}
#[test]
fn foreign_lifecycle_is_refused_before_configuration_or_any_native_query() {
    crate::test_process::owning_case!(
        foreign_lifecycle_is_refused_before_configuration_or_any_native_query
    );
    let first_tree = Tree::new();
    let other_tree = Tree::new();
    let first = broker(&first_tree);
    let other = broker(&other_tree);
    let foreign = other.installed.lifecycle().unwrap();
    let candidate = resources(&first_tree);
    let error = first
        .check_creation_budget_locked(&foreign, &session(), &candidate, None)
        .unwrap_err();
    assert_eq!(error.code(), "WORKER_CREATION_LIFECYCLE_ORIGIN");
    assert!(!first_tree.root.join("calls.txt").exists());
    assert!(!other_tree.root.join("calls.txt").exists());
    drop(foreign);
    for broker in [first, other] {
        broker.close_command_telemetry(end()).unwrap();
        broker.storage.runtime.close(end()).unwrap();
    }
}
