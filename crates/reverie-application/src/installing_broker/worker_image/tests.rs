//! Actual broker/runtime/query owners. These negatives establish no qualified
//! loaded image and deliberately never fake a successful immutable input.
use super::*;
use crate::{
    reservation_gate::tests::Tree, test_process::engine_program,
    worker_validation::load_owner_config,
};
use reverie_core::{PythonText, operations::JournalDigest};
use reverie_host::{
    engine_metadata::EngineBootstrap, installed_worker_engine::InstalledWorkerEngine,
    worker_runtime::WorkerRuntime,
};
use std::{collections::BTreeMap, fs};
fn broker(tree: &Tree) -> InstallingBroker {
    let program = tree.root.join("storage-writer");
    fs::hard_link(engine_program(), &program).unwrap();
    let snapshot = load_owner_config(&tree.root.join("worker.json")).unwrap();
    let bootstrap =
        EngineBootstrap::from_service(program.as_os_str(), BTreeMap::new(), tree.root.clone())
            .unwrap();
    let runtime = WorkerRuntime::new(
        InstalledWorkerEngine::new(bootstrap),
        snapshot.envelope().base(),
    );
    InstallingBroker::new(snapshot, runtime).unwrap()
}
fn reference() -> ArtifactReference {
    ArtifactReference {
        path: PythonText::from_scalar_text("/outside-store/invalid.json"),
        sha256: JournalDigest::parse(&"a".repeat(64)).unwrap(),
    }
}
fn refusal(end: Instant, expected: &str) {
    let tree = Tree::new();
    let broker = broker(&tree);
    let before = broker.configuration().unwrap();
    let marker = fs::read(tree.root.join("state/resource-reservation-control.json")).unwrap();
    let calls = fs::read(tree.root.join("calls.txt")).ok();
    let mut failure = broker
        .qualify_worker_image(
            reference(),
            reference(),
            WorkerImageId::parse(&format!("sha256:{}", "b".repeat(64))).unwrap(),
            end,
        )
        .err()
        .expect("no successful qualifier");
    assert_eq!(failure.cause().code(), expected);
    assert!(
        failure.owner.is_some(),
        "whole actual context retained before fallibles"
    );
    assert!(Arc::ptr_eq(&before, &broker.configuration().unwrap()));
    assert_eq!(fs::read(tree.root.join("calls.txt")).ok(), calls);
    failure
        .close_components(Instant::now() + Duration::from_secs(2))
        .unwrap();
    assert!(failure.owner.is_none());
    assert_eq!(fs::read(tree.root.join("worker.json")).unwrap(), tree.raw);
    assert_eq!(
        fs::read(tree.root.join("state/resource-reservation-control.json")).unwrap(),
        marker
    );
    broker
        .storage
        .runtime
        .close(Instant::now() + Duration::from_secs(2))
        .unwrap();
}
#[test]
fn expired_native_image_qualification_keeps_original_owner_before_any_file_or_engine_query() {
    refusal(Instant::now(), "WORKER_IMAGE_QUALIFICATION_DEADLINE");
}
#[test]
fn nonstore_image_reference_refuses_without_query_or_reservation_mutation() {
    refusal(
        Instant::now() + Duration::from_secs(10),
        "IMMUTABLE_CODE_PATH",
    );
}
#[test]
fn composed_file_error_walks_both_branches_without_classifying_known_io_as_close_unknown() {
    let tree = Tree::new();
    let broker = broker(&tree);
    let snapshot = broker.configuration().unwrap();
    let mut files = reverie_host::worker_image::ImageControlFiles::capture(
        &tree.root.join("missing-worker.json"),
        snapshot.configuration(),
    );
    let original = files
        .read_configuration()
        .err()
        .expect("actual named file absent");
    assert!(!original.has_unconfirmed_close());
    for primary in [true, false] {
        let leaf = GateError::ImageFiles(original.clone());
        let other = GateError::Refused("OWNED_CLEANUP_NEGATIVE");
        let (a, b) = if primary {
            (leaf, other)
        } else {
            (other, leaf)
        };
        let wrapped = GateError::Finalization {
            primary: Box::new(a),
            secondary: Box::new(b),
        };
        let found = super::prepare::image_file_error(&wrapped)
            .expect("typed original leaf in either branch");
        assert_eq!(found.code(), original.code());
        assert!(!found.has_unconfirmed_close());
    }
    broker
        .storage
        .runtime
        .close(Instant::now() + Duration::from_secs(2))
        .unwrap();
}

#[test]
fn offline_inspection_closes_the_real_fresh_broker_once_without_changing_ready_or_querying() {
    let tree = Tree::new();
    let broker = broker(&tree);
    let marker = fs::read(tree.root.join("state/resource-reservation-control.json")).unwrap();
    let calls = fs::read(tree.root.join("calls.txt")).ok();
    broker
        .close_offline_image_inspection(Instant::now() + Duration::from_secs(2))
        .unwrap();
    let stop = broker
        .storage
        .runtime
        .stop_deadline()
        .expect("actual runtime closed");
    let failure = broker
        .close_offline_image_inspection(Instant::now() + Duration::from_secs(2))
        .expect_err("original close attempt is one-shot");
    assert_eq!(
        failure.cause().code(),
        "WORKER_IMAGE_REQUIRES_UNSTARTED_BROKER"
    );
    assert_eq!(broker.storage.runtime.stop_deadline(), Some(stop));
    assert_eq!(fs::read(tree.root.join("calls.txt")).ok(), calls);
    assert_eq!(fs::read(tree.root.join("worker.json")).unwrap(), tree.raw);
    assert_eq!(
        fs::read(tree.root.join("state/resource-reservation-control.json")).unwrap(),
        marker
    );
}

#[test]
fn inspection_controller_slot_contention_refuses_before_runtime_stop_or_native_query() {
    let tree = Tree::new();
    let broker = broker(&tree);
    let original_slot = broker.controller.lock().unwrap();
    let failure = broker
        .close_offline_image_inspection(Instant::now() + Duration::from_secs(2))
        .expect_err("same original slot must be exclusively held");
    assert_eq!(failure.cause().code(), "WORKER_CONTROLLER_SLOT_UNAVAILABLE");
    assert!(broker.storage.runtime.stop_deadline().is_none());
    drop(original_slot);
    broker
        .close_offline_image_inspection(Instant::now() + Duration::from_secs(2))
        .unwrap();
}
