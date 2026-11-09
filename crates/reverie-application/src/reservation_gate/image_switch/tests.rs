//! Real private READY/admission files with the established bounded native
//! census fixture. No stopped-service, loaded image or publication grant.
use super::super::*;
use crate::{reservation_gate::tests::Tree, reservation_observer::tests::Fixture};
use std::{fs, os::unix::fs::MetadataExt};
mod entered;
mod publication;
fn fixture(rows: &[serde_json::Value]) -> Arc<Fixture> {
    let fixture = Fixture::new();
    for _ in 0..24 {
        fixture.inventory(rows);
    }
    fixture
}
fn unchanged(tree: &Tree, before: &[u8], marker: &[u8], inode: u64) {
    assert_eq!(fs::read(tree.root.join("worker.json")).unwrap(), before);
    assert_eq!(
        fs::read(tree.root.join("state/resource-reservation-control.json")).unwrap(),
        marker
    );
    assert_eq!(
        fs::metadata(tree.root.join("state/resource-reservation-control.json"))
            .unwrap()
            .ino(),
        inode
    );
}
#[test]
fn image_idle_requires_actual_held_admission_before_native_observation() {
    let tree = Tree::new();
    let source = fixture(&[]);
    let gate = tree.gate(&source, true);
    let before = source.events();
    let error = gate.inner.image_idle().err().expect("no held R scope");
    assert_eq!(error.code(), "RESERVATION_ADMISSION_LOCK_REQUIRED");
    assert_eq!(source.events(), before);
}
#[test]
fn image_idle_with_real_ready_admission_preserves_configuration_marker_and_journal() {
    let tree = Tree::new();
    let source = fixture(&[]);
    let gate = tree.gate(&source, true);
    let marker = fs::read(tree.root.join("state/resource-reservation-control.json")).unwrap();
    let inode = fs::metadata(tree.root.join("state/resource-reservation-control.json"))
        .unwrap()
        .ino();
    let journal = fs::read(tree.root.join("control/operations/operations.json")).unwrap();
    let admission = gate.inner.admit(AdmissionBounds::default()).unwrap();
    let body = gate.inner.image_idle();
    admission.conclude(body).unwrap();
    unchanged(&tree, &tree.raw, &marker, inode);
    assert_eq!(
        fs::read(tree.root.join("control/operations/operations.json")).unwrap(),
        journal
    );
}
#[test]
fn image_idle_refuses_unlabelled_deployment_name_even_when_not_registered() {
    let tree = Tree::new();
    let row = serde_json::json!({"Id":"a".repeat(64),"Name":"/test-agent-33333333-2222-4333-8444-555555555555","Image":format!("sha256:{}","a".repeat(64)),"Config":{"Labels":{}},"State":{"Running":true,"Pid":123},"Mounts":[],"HostConfig":{"Memory":536870912,"MemorySwap":536870912,"PidsLimit":128,"NanoCpus":0}});
    let source = fixture(&[row]);
    let gate = tree.gate(&source, true);
    let admission = gate.inner.admit(AdmissionBounds::default()).unwrap();
    let body = gate.inner.image_idle();
    let error = admission
        .conclude(body)
        .err()
        .expect("name-selected live laptop must refuse");
    assert_eq!(error.code(), "WORKER_IMAGE_LAPTOPS_MUST_BE_STOPPED");
    assert_eq!(fs::read(tree.root.join("worker.json")).unwrap(), tree.raw);
}
#[test]
fn image_idle_rechecks_original_disk_image_without_rewriting_foreign_change() {
    let tree = Tree::new();
    let source = fixture(&[]);
    let gate = tree.gate(&source, true);
    let admission = gate.inner.admit(AdmissionBounds::default()).unwrap();
    let mut changed: serde_json::Value = serde_json::from_slice(&tree.raw).unwrap();
    changed["image"] = serde_json::json!(format!("sha256:{}", "b".repeat(64)));
    let changed = serde_json::to_vec(&changed).unwrap();
    tree.write("worker.json", &changed);
    assert!(admission.conclude(gate.inner.image_idle()).is_err());
    assert_eq!(fs::read(tree.root.join("worker.json")).unwrap(), changed);
}
