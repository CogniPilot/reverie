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
