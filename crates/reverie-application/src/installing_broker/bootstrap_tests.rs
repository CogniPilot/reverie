use super::*;
use crate::{reservation_gate::tests::Tree, worker_validation::load_owner_config};
use reverie_host::{
    engine_metadata::EngineBootstrap, installed_worker_engine::InstalledWorkerEngine,
    worker_runtime::WorkerRuntime,
};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::symlink,
    time::{Duration, Instant},
};
fn unreserved(tree: &Tree) {
    let mut raw: Value = serde_json::from_slice(&tree.raw).unwrap();
    raw.as_object_mut().unwrap().remove("resourceReservations");
    tree.write("worker.json", &serde_json::to_vec(&raw).unwrap());
    tree.write("company.json", br#"{"employees":[]}"#);
}
fn broker(tree: &Tree) -> Result<InstallingBroker, Box<BrokerBootstrapFailure>> {
    let snapshot = load_owner_config(&tree.root.join("worker.json")).unwrap();
    // Construction/legacy resolution must not query the engine. A query to
    // this real captured test executable would fail instead of faking success.
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
    InstallingBroker::new(snapshot, runtime)
}
#[test]
fn absent_optional_control_bootstraps_actual_current_owner_and_genuine_legacy_storage() {
    let tree = Tree::new();
    unreserved(&tree);
    fs::remove_file(tree.root.join("state/resource-reservation-control.json")).unwrap();
    fs::remove_dir_all(tree.root.join("control")).unwrap();
    let broker = broker(&tree).unwrap();
    assert!(broker.resource_reservations().unwrap().is_none());
    assert_eq!(
        broker.reload_resources().unwrap_err().code(),
        "RESERVATION_NOT_CONFIGURED"
    );
    let session = ProfileSessionId::parse("00000000-0000-0000-0000-000000000000").unwrap();
    let claim = broker.claim_storage(&session).unwrap();
    assert!(!claim.newly_claimed());
    assert_eq!(
        claim.paths().kind(),
        reverie_store::storage_identity::StorageKind::Session
    );
    assert!(!tree.root.join("control").exists());
    assert!(!tree.root.join("state/storage-locks").exists());
    claim
        .release(Instant::now() + Duration::from_secs(2))
        .unwrap();
    broker
        .storage
        .runtime
        .close(Instant::now() + Duration::from_secs(2))
        .unwrap();
}
#[test]
fn removed_option_cannot_hide_any_durable_marker_or_pending_alias_at_bootstrap() {
    for recipe in [
        "marker-file",
        "marker-directory",
        "marker-dangling",
        "pending-file",
        "pending-dangling",
    ] {
        let tree = Tree::new();
        unreserved(&tree);
        let marker = tree.root.join("state/resource-reservation-control.json");
        fs::remove_file(&marker).unwrap();
        let pending = tree.root.join("state/resource-reservation-control.pending");
        match recipe {
            "marker-file" => {
                tree.write("state/resource-reservation-control.json", b"retained fence")
            }
            "marker-directory" => fs::create_dir(marker).unwrap(),
            "marker-dangling" => symlink(tree.root.join("absent"), marker).unwrap(),
            "pending-file" => tree.write(
                "state/resource-reservation-control.pending",
                b"retained pending",
            ),
            "pending-dangling" => symlink(tree.root.join("absent"), pending).unwrap(),
            _ => unreachable!(),
        }
        assert_eq!(
            broker(&tree).err().unwrap().code(),
            "RESERVATION_POLICY_REMOVED",
            "{recipe}"
        );
    }
}
#[test]
fn late_durable_fence_refuses_unreserved_feature_selection_without_installing_a_fake_gate() {
    let tree = Tree::new();
    unreserved(&tree);
    fs::remove_file(tree.root.join("state/resource-reservation-control.json")).unwrap();
    let broker = broker(&tree).unwrap();
    assert!(broker.resource_reservations().unwrap().is_none());
    symlink(
        tree.root.join("absent"),
        tree.root.join("state/resource-reservation-control.pending"),
    )
    .unwrap();
    assert_eq!(
        broker.resource_reservations().err().unwrap().code(),
        "RESERVATION_INSTALL_REQUIRES_RECONCILIATION"
    );
    assert!(broker.gate.is_none());
    broker
        .storage
        .runtime
        .close(Instant::now() + Duration::from_secs(2))
        .unwrap();
}

#[test]
fn actual_claim_prepares_same_runtime_observed_plan_without_a_second_resolver_or_engine_query() {
    let tree = Tree::new();
    unreserved(&tree);
    fs::remove_file(tree.root.join("state/resource-reservation-control.json")).unwrap();
    let broker = broker(&tree).unwrap();
    let sid = ProfileSessionId::parse("00000000-0000-0000-0000-000000000000").unwrap();
    let claim = broker.claim_storage(&sid).unwrap();
    let source = broker.configuration().unwrap();
    let plan = claim.prepare_create_plan(&source).unwrap();
    let same = plan.same_runtime(&broker.storage.runtime);
    let paths_same = plan.storage() == claim.paths();
    claim
        .release(Instant::now() + Duration::from_secs(2))
        .unwrap();
    broker
        .storage
        .runtime
        .close(Instant::now() + Duration::from_secs(2))
        .unwrap();
    assert!(same && paths_same);
    assert_eq!(plan.session(), &sid);
    assert!(reverie_contracts::worker_config::equivalent(
        plan.source(),
        source.configuration()
    ));
}
