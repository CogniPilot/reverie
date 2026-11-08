//! Real private R admission +actual Host files/CAS. These internal mechanism
//! controls supply no stopped-service or immutable loaded-image grant.
use super::*;
use reverie_contracts::worker_image_switch::{ImagePinTransition, WorkerImageId};
use reverie_core::operations::{JournalDigest, JournalId};
use reverie_host::worker_image::ImageControlFiles;
use std::time::Duration;
fn end() -> Instant {
    Instant::now() + Duration::from_secs(10)
}
fn files(tree: &Tree, gate: &ReservationGate) -> (ImageControlFiles, Arc<ImagePinTransition>) {
    let before = gate.inner.installed.snapshot().unwrap();
    let intent = ImagePinTransition::prepare(
        &tree.raw,
        &WorkerImageId::parse(before.envelope().base().image()).unwrap(),
        WorkerImageId::parse(&format!("sha256:{}", "b".repeat(64))).unwrap(),
        JournalId::parse("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee").unwrap(),
        JournalDigest::parse(&"c".repeat(64)).unwrap(),
    )
    .unwrap();
    (
        ImageControlFiles::capture(&tree.root.join("worker.json"), before.configuration()),
        Arc::new(intent),
    )
}
#[test]
fn file_transition_requires_same_current_admission_before_any_pending_effect() {
    let tree = Tree::new();
    let source = fixture(&[]);
    let gate = tree.gate(&source, true);
    let admission = gate.inner.admit(AdmissionBounds::default()).unwrap();
    let rows = Arc::new(gate.inner.image_idle().unwrap());
    admission.conclude(Ok(())).unwrap();
    let (files, intent) = files(&tree, &gate);
    let error = gate
        .inner
        .begin_image_transition(files, rows, intent)
        .err()
        .expect("actual held scope required");
    assert_eq!(error.code(), "RESERVATION_ADMISSION_LOCK_REQUIRED");
    assert!(
        !tree
            .root
            .join("state/resource-reservation-control.pending")
            .exists()
    );
}
#[test]
fn actual_image_cas_updates_same_context_and_preserves_ready_profiles_and_journal() {
    let tree = Tree::new();
    let source = fixture(&[]);
    let gate = tree.gate(&source, true);
    let marker = fs::read(tree.root.join("state/resource-reservation-control.json")).unwrap();
    let inode = fs::metadata(tree.root.join("state/resource-reservation-control.json"))
        .unwrap()
        .ino();
    let journal = fs::read(tree.root.join("control/operations/operations.json")).unwrap();
    let (files, intent) = files(&tree, &gate);
    let admission = gate.inner.admit(AdmissionBounds::default()).unwrap();
    let rows = Arc::new(gate.inner.image_idle().unwrap());
    let record = gate
        .inner
        .begin_image_transition(files, rows, intent.clone())
        .unwrap();
    let protected = record.protected_stores().unwrap();
    record.publish_pending(end()).unwrap();
    gate.inner.guard(None).unwrap();
    record.publish_configuration().unwrap();
    let lifecycle = gate.inner.installed.lifecycle().unwrap();
    gate.inner
        .publish_image_record(&record, &lifecycle)
        .unwrap();
    admission.conclude(Ok(())).unwrap();
    let terminal = record.terminal(&protected).unwrap();
    record.release(&terminal).unwrap();
    assert_eq!(
        fs::read(tree.root.join("worker.json")).unwrap(),
        intent.configuration_bytes()
    );
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
    assert_eq!(
        fs::read(tree.root.join("control/operations/operations.json")).unwrap(),
        journal
    );
    assert_eq!(
        gate.inner
            .installed
            .snapshot()
            .unwrap()
            .envelope()
            .base()
            .image(),
        intent.new_image().as_str()
    );
    assert!(
        !tree
            .root
            .join("state/resource-reservation-control.pending")
            .exists()
    );
}
