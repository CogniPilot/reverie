//! Actual openat2 private-root controls. No production Nix-store edit, mount,
//! namespace switch, root identity, website provenance or execution grant.
use super::*;
use reverie_core::PythonText;
use std::{
    os::unix::fs::{DirBuilderExt, symlink},
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    root: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "nix-code-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        fs::create_dir_all(root.join("nix/store/sample")).unwrap();
        fs::write(root.join("nix/store/sample/code"), b"image bytes").unwrap();
        Self { root }
    }
    fn descriptor(&self) -> File {
        OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC)
            .open(&self.root)
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}
#[test]
fn actual_in_root_absolute_open_reads_owned_guest_without_host_path_fallback() {
    let fixture = Fixture::new();
    let mut files = Descriptors::default();
    let root = files.retain(fixture.descriptor());
    let guest =
        files.retain(open_image(files.get(root), Path::new("/nix/store/sample/code")).unwrap());
    let mut bytes = Vec::new();
    let body = files.get_mut(guest).read_to_end(&mut bytes);
    let closed = files.close();
    body.unwrap();
    closed.unwrap();
    assert_eq!(bytes, b"image bytes");
}
#[test]
fn actual_guest_leaf_and_parent_symlinks_are_refused_without_following() {
    let fixture = Fixture::new();
    symlink(
        "/nix/store/sample/code",
        fixture.root.join("nix/store/sample/link"),
    )
    .unwrap();
    symlink("/nix/store/sample", fixture.root.join("nix/store/alias")).unwrap();
    let mut files = Descriptors::default();
    let root = files.retain(fixture.descriptor());
    let leaf = open_image(files.get(root), Path::new("/nix/store/sample/link"));
    let parent = open_image(files.get(root), Path::new("/nix/store/alias/code"));
    // Even an unexpected positive result remains owned and is checked-closed
    // before assertions, so a failed regression cannot leak an actual fd.
    let leaf_refused = leaf.is_err();
    let parent_refused = parent.is_err();
    for file in [leaf, parent].into_iter().flatten() {
        files.retain(file);
    }
    files.close().unwrap();
    assert!(leaf_refused && parent_refused);
}
#[test]
fn manifest_paths_reject_parent_normalization_nul_and_non_nix_roots() {
    for raw in [
        "relative",
        "/nix/store/a/../b",
        "/nix/store//a",
        "/nix/store/a\0b",
        "/etc/passwd",
    ] {
        assert!(
            nix_path(&PythonText::from_scalar_text(raw)).is_err(),
            "{raw:?}"
        );
    }
    assert_eq!(
        nix_path(&PythonText::from_scalar_text("/nix/store/a/code")).unwrap(),
        Path::new("/nix/store/a/code")
    );
}
