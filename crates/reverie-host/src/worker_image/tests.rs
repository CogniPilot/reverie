//! Actual private file owners; no service, worker or image effects.
use super::*;
use reverie_contracts::worker_image_switch::WorkerImageId;
use reverie_core::operations::{JournalDigest, JournalId};
use std::os::unix::fs::PermissionsExt;

struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let path = nix::unistd::mkdtemp(&std::env::temp_dir().join("image-files-XXXXXX")).unwrap();
        Self(path)
    }
    fn write(&self, name: &str, raw: &[u8]) -> PathBuf {
        let path = self.0.join(name);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(&path, raw).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        path
    }
    fn raw(&self) -> Vec<u8> {
        format!("{{\n  \"uid\": {}, \"stateRoot\": {:?},\n  \"resourceReservations\": {{\"directory\": {:?}}},\n  \"image\": \"sha256:{}\", \"untouched\": [1, true]\n}}\n", nix::unistd::geteuid().as_raw(), self.0, self.0.join("control"), "a".repeat(64)).into_bytes()
    }
    fn files(&self) -> ImageControlFiles {
        let raw = self.raw();
        let source = self.write("broker.json", &raw);
        self.write("resource-reservation-control.json", b"{\"unchanged\":true}");
        self.write("control/operations/operations.json", b"{\"operations\":{}}");
        self.write("control/profiles/profiles.json", b"{\"profiles\":{}}");
        ImageControlFiles::capture(
            &source,
            &reverie_contracts::worker_config::decode(&raw).unwrap(),
        )
    }
    fn intent(&self) -> Arc<ImagePinTransition> {
        Arc::new(
            ImagePinTransition::prepare(
                &self.raw(),
                &WorkerImageId::parse(&format!("sha256:{}", "a".repeat(64))).unwrap(),
                WorkerImageId::parse(&format!("sha256:{}", "b".repeat(64))).unwrap(),
                JournalId::parse("11111111-1111-4111-8111-111111111111").unwrap(),
                JournalDigest::parse(&"c".repeat(64)).unwrap(),
            )
            .unwrap(),
        )
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        native::test_faults::set(None, false);
        gpu_access::clear_image_fixture_faults();
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn post_rename_foreign_target_or_consumed_close_never_releases_pending_or_retries() {
    for close in [false, true] {
        let tree = Tree::new();
        let mut files = tree.files();
        let original = files.read_configuration().unwrap();
        let intent = tree.intent();
        let pending = files
            .publish_pending(
                intent.clone(),
                Instant::now() + std::time::Duration::from_secs(10),
            )
            .unwrap();
        gpu_access::image_after_rename_fixture_fault(close);
        let error = files
            .publish_configuration(&intent, original.stamp(), &pending)
            .err()
            .unwrap();
        assert!(error.is_uncertain());
        assert_eq!(error.has_unconfirmed_close(), close);
        assert!(tree.0.join("resource-reservation-control.pending").exists());
        let actual = fs::read(tree.0.join("broker.json")).unwrap();
        assert!(
            files
                .publish_configuration(&intent, original.stamp(), &pending)
                .is_err()
        );
        assert_eq!(fs::read(tree.0.join("broker.json")).unwrap(), actual);
        if close {
            assert_eq!(actual, intent.configuration_bytes());
        } else {
            assert_eq!(actual, b"foreign post-rename bytes");
            assert_eq!(
                fs::read(tree.0.join("original-published-image")).unwrap(),
                intent.configuration_bytes()
            );
        }
    }
}

#[test]
fn actual_image_only_cas_preserves_ready_and_journals_then_releases_own_pending_last() {
    let tree = Tree::new();
    let mut files = tree.files();
    let original = files.read_configuration().unwrap();
    assert_eq!(original.bytes(), tree.raw());
    let protected = files.protected_stores().unwrap();
    let parents = files.capture_parents().unwrap();
    let intent = tree.intent();
    let end = Instant::now() + std::time::Duration::from_secs(10);
    let mut pending = files.publish_pending(intent.clone(), end).unwrap();
    let published = files
        .publish_configuration(&intent, original.stamp(), &pending)
        .unwrap();
    assert_eq!(
        fs::read(tree.0.join("broker.json")).unwrap(),
        intent.configuration_bytes()
    );
    assert_eq!(
        fs::read(tree.0.join("resource-reservation-control.json")).unwrap(),
        b"{\"unchanged\":true}"
    );
    parents.assert_current().unwrap();
    let terminal = files
        .capture_terminal(&published, &pending, &protected)
        .unwrap();
    terminal.assert_current().unwrap();
    assert!(tree.0.join("resource-reservation-control.pending").exists());
    files.release_pending(&mut pending, &terminal).unwrap();
    assert!(!tree.0.join("resource-reservation-control.pending").exists());
    assert!(files.release_pending(&mut pending, &terminal).is_err());
}

#[test]
fn actual_source_cas_drift_retains_foreign_bytes_and_original_pending_without_retry() {
    let tree = Tree::new();
    let mut files = tree.files();
    let original = files.read_configuration().unwrap();
    let intent = tree.intent();
    let pending = files
        .publish_pending(
            intent.clone(),
            Instant::now() + std::time::Duration::from_secs(10),
        )
        .unwrap();
    tree.write("broker.json", b"{\"foreign\":true}");
    assert!(
        files
            .publish_configuration(&intent, original.stamp(), &pending)
            .is_err()
    );
    let bytes = fs::read(tree.0.join("broker.json")).unwrap();
    assert!(
        files
            .publish_configuration(&intent, original.stamp(), &pending)
            .is_err()
    );
    assert_eq!(fs::read(tree.0.join("broker.json")).unwrap(), bytes);
    assert!(tree.0.join("resource-reservation-control.pending").exists());
}

#[test]
fn replacing_original_pending_with_equal_bytes_refuses_before_configuration_cas() {
    let tree = Tree::new();
    let mut files = tree.files();
    let original = files.read_configuration().unwrap();
    let intent = tree.intent();
    let pending = files
        .publish_pending(
            intent.clone(),
            Instant::now() + std::time::Duration::from_secs(10),
        )
        .unwrap();
    let pending_path = tree.0.join("resource-reservation-control.pending");
    fs::rename(&pending_path, tree.0.join("original-pending")).unwrap();
    tree.write("resource-reservation-control.pending", intent.bytes());
    let result = files.publish_configuration(&intent, original.stamp(), &pending);
    let source = fs::read(tree.0.join("broker.json")).unwrap();
    let pending_bytes = fs::read(&pending_path).unwrap();
    assert!(
        result.is_err(),
        "the original pending inode must still fence the writer"
    );
    assert_eq!(source, tree.raw());
    assert_eq!(pending_bytes, intent.bytes());
    assert_eq!(
        fs::read(tree.0.join("original-pending")).unwrap(),
        intent.bytes()
    );
}

#[test]
fn replacing_pending_after_configuration_preparation_refuses_before_rename() {
    let tree = Tree::new();
    let mut files = tree.files();
    let original = files.read_configuration().unwrap();
    let intent = tree.intent();
    let pending = files
        .publish_pending(
            intent.clone(),
            Instant::now() + std::time::Duration::from_secs(10),
        )
        .unwrap();
    gpu_access::image_pending_swap_before_cas_fixture_fault();
    let result = files.publish_configuration(&intent, original.stamp(), &pending);
    let source = fs::read(tree.0.join("broker.json")).unwrap();
    assert!(
        result.is_err(),
        "pending must still be original after temporary-file setup"
    );
    assert_eq!(source, tree.raw());
    assert_eq!(
        fs::read(tree.0.join("original-pending")).unwrap(),
        intent.bytes()
    );
    assert_eq!(
        fs::read(tree.0.join("resource-reservation-control.pending")).unwrap(),
        intent.bytes()
    );
}

#[test]
fn foreign_pending_is_never_adopted_overwritten_or_unlinked() {
    let tree = Tree::new();
    let mut files = tree.files();
    tree.write("resource-reservation-control.pending", b"foreign evidence");
    assert!(
        files
            .publish_pending(
                tree.intent(),
                Instant::now() + std::time::Duration::from_secs(10)
            )
            .is_err()
    );
    assert_eq!(
        fs::read(tree.0.join("resource-reservation-control.pending")).unwrap(),
        b"foreign evidence"
    );
    assert_eq!(fs::read(tree.0.join("broker.json")).unwrap(), tree.raw());
}

#[test]
fn original_reader_consumed_close_failure_is_sticky_before_any_publication() {
    let tree = Tree::new();
    let mut files = tree.files();
    native::test_faults::set(None, true);
    let first = files.read_configuration().err().unwrap();
    native::test_faults::set(None, false);
    assert!(first.has_unconfirmed_close());
    assert_eq!(
        files.read_configuration().err().unwrap().code(),
        first.code()
    );
    assert!(
        files
            .publish_pending(
                tree.intent(),
                Instant::now() + std::time::Duration::from_secs(10)
            )
            .is_err()
    );
    assert!(!tree.0.join("resource-reservation-control.pending").exists());
}

#[test]
fn terminal_from_another_actual_file_owner_cannot_release_same_named_pending() {
    let tree = Tree::new();
    let mut files = tree.files();
    let original = files.read_configuration().unwrap();
    let protected = files.protected_stores().unwrap();
    let intent = tree.intent();
    let mut pending = files
        .publish_pending(
            intent.clone(),
            Instant::now() + std::time::Duration::from_secs(10),
        )
        .unwrap();
    let published = files
        .publish_configuration(&intent, original.stamp(), &pending)
        .unwrap();
    let terminal = files
        .capture_terminal(&published, &pending, &protected)
        .unwrap();
    let config = reverie_contracts::worker_config::decode(intent.configuration_bytes()).unwrap();
    let mut foreign = ImageControlFiles::capture(&tree.0.join("broker.json"), &config);
    assert!(foreign.release_pending(&mut pending, &terminal).is_err());
    assert!(tree.0.join("resource-reservation-control.pending").exists());
}

#[test]
fn image_fence_preserves_actual_consumed_close_in_either_finalization_branch() {
    use gpu_access::GpuHostError as Gpu;
    let tree = Tree::new();
    let mut files = tree.files();
    native::test_faults::set(None, true);
    let actual_close = files.read_configuration().err().unwrap();
    native::test_faults::set(None, false);
    let ordinary = ImageFileError::io(std::io::Error::other("ordinary metadata refusal"));
    for (leaf, close) in [(actual_close, true), (ordinary, false)] {
        let direct = Gpu::ImageFence(Box::new(leaf.clone()));
        assert_eq!(direct.code(), leaf.code());
        assert_eq!(direct.is_uncertain(), close);
        for primary in [false, true] {
            let fence = Box::new(Gpu::ImageFence(Box::new(leaf.clone())));
            let refusal = Box::new(Gpu::Refused("ORDINARY_PRIMARY"));
            let (primary, secondary) = if primary {
                (fence, refusal)
            } else {
                (refusal, fence)
            };
            let composed =
                ImageFileError::shared(Gpu::PublicationUnknown(Box::new(Gpu::Finalized {
                    primary,
                    secondary,
                })));
            assert_eq!(composed.has_unconfirmed_close(), close);
            assert!(composed.is_uncertain());
        }
    }
}
