//! Actual retained Gate entry/cleanup; immutable image/service qualification is
//! deliberately outside these private mechanism controls.
use super::*;
use reverie_contracts::{resource_actor::ArtifactReference, worker_image_switch::WorkerImageId};
use reverie_core::{
    PythonText,
    operations::{JournalDigest, JournalId},
};
use reverie_host::worker_image::ImageControlFiles;
use std::time::Duration;

fn preview(
    gate: &ReservationGate,
    tree: &Tree,
) -> (ImageControlFiles, super::super::ImageSwitchPreview) {
    let before = gate.inner.installed.snapshot().unwrap();
    let mut files =
        ImageControlFiles::capture(&tree.root.join("worker.json"), before.configuration());
    let reference = ArtifactReference {
        path: PythonText::from_scalar_text("/nix/store/unused-preview-data"),
        sha256: JournalDigest::parse(&"c".repeat(64)).unwrap(),
    };
    let preview = gate
        .preview_offline_image(
            &mut files,
            &before,
            &WorkerImageId::parse(&format!("sha256:{}", "b".repeat(64))).unwrap(),
            &reference,
            &reference,
            Instant::now() + Duration::from_secs(15),
        )
        .unwrap();
    (files, preview)
}
fn operation() -> JournalId {
    JournalId::parse("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee").unwrap()
}
fn source() -> Arc<Fixture> {
    let source = Fixture::new();
    for _ in 0..96 {
        source.inventory(&[]);
    }
    source
}
fn pending(tree: &Tree) -> std::path::PathBuf {
    tree.root.join("state/resource-reservation-control.pending")
}
#[test]
fn entered_image_owner_aborts_original_admission_without_publication_or_marker_change() {
    let tree = Tree::new();
    let source = source();
    let gate = tree.gate(&source, true);
    let marker = fs::read(tree.root.join("state/resource-reservation-control.json")).unwrap();
    let inode = fs::metadata(tree.root.join("state/resource-reservation-control.json"))
        .unwrap()
        .ino();
    let (files, preview) = preview(&gate, &tree);
    let mut entered = gate
        .enter_image_switch(
            files,
            preview,
            operation(),
            Instant::now() + Duration::from_secs(15),
        )
        .unwrap_or_else(|error| panic!("{}", error.cause()));
    entered.close_components().unwrap();
    unchanged(&tree, &tree.raw, &marker, inode);
    assert!(!pending(&tree).exists());
    gate.inner
        .admit(AdmissionBounds::default())
        .unwrap()
        .conclude(Ok(()))
        .unwrap();
}
#[test]
fn changed_source_after_real_preview_refuses_before_pending_and_retains_foreign_bytes() {
    let tree = Tree::new();
    let source = source();
    let gate = tree.gate(&source, true);
    let (files, preview) = preview(&gate, &tree);
    let mut changed = tree.raw.clone();
    changed.push(b' ');
    tree.write("worker.json", &changed);
    let mut failure = gate
        .enter_image_switch(
            files,
            preview,
            operation(),
            Instant::now() + Duration::from_secs(15),
        )
        .err()
        .expect("same original source stamp required");
    failure.close_components().unwrap();
    assert_eq!(fs::read(tree.root.join("worker.json")).unwrap(), changed);
    assert!(!pending(&tree).exists());
}
#[test]
fn foreign_file_owner_cannot_enter_an_otherwise_identical_preview() {
    let tree = Tree::new();
    let foreign = Tree::new();
    let source = source();
    let gate = tree.gate(&source, true);
    let (_, preview) = preview(&gate, &tree);
    let before = gate.inner.installed.snapshot().unwrap();
    let files =
        ImageControlFiles::capture(&foreign.root.join("worker.json"), before.configuration());
    let mut failure = gate
        .enter_image_switch(
            files,
            preview,
            operation(),
            Instant::now() + Duration::from_secs(15),
        )
        .err()
        .expect("original file identity required");
    assert_eq!(failure.cause().code(), "WORKER_IMAGE_PREVIEW_CHANGED");
    failure.close_components().unwrap();
    assert_eq!(fs::read(tree.root.join("worker.json")).unwrap(), tree.raw);
    assert_eq!(
        fs::read(foreign.root.join("worker.json")).unwrap(),
        foreign.raw
    );
    assert!(!pending(&tree).exists());
    assert!(!pending(&foreign).exists());
}
