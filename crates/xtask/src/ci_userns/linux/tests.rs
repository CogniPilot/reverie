//! Read-only selector/metadata checks plus owned refusal fixtures. These never
//! call prepare(), sudo, AppArmor, bwrap or unshare.
use super::*;
use std::{
    os::unix::fs::PermissionsExt,
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "ci-tool-selection-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn file(&self, name: &str, mode: u32) -> PathBuf {
        let path = self.0.join(name);
        fs::write(&path, "owned inert fixture; never executed").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
        path
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
#[test]
fn first_executable_path_match_and_explicit_override_never_fall_through_to_another_tool() {
    let root = Fixture::new();
    root.file("bwrap", 0o555);
    let search = std::env::join_paths([root.0.as_path(), Path::new("/bin")]).unwrap();
    let error = select_tool(NamespaceTool::Bubblewrap, &search, None).unwrap_err();
    assert!(error.to_string().contains("exact immutable Nix"));
    let absent = root.0.join("absent");
    let error =
        select_tool(NamespaceTool::Bubblewrap, &search, Some(absent.as_os_str())).unwrap_err();
    assert!(error.downcast_ref::<std::io::Error>().is_some());
    let error = select_tool(
        NamespaceTool::Unshare,
        &search,
        Some(root.0.join("bwrap").as_os_str()),
    )
    .unwrap_err();
    assert!(error.to_string().contains("exact immutable Nix"));
}
#[test]
fn no_tool_or_nonexecutable_entry_does_not_qualify() {
    let root = Fixture::new();
    root.file("bwrap", 0o444);
    assert!(select_tool(NamespaceTool::Bubblewrap, root.0.as_os_str(), None).is_err());
    assert!(select_tool(NamespaceTool::Unshare, root.0.as_os_str(), None).is_err());
}
#[test]
fn explicit_relative_naked_or_empty_selector_refuses_before_any_path_lookup() {
    for selector in ["bwrap", "./bwrap", "../bwrap", ""] {
        let error = select_tool(
            NamespaceTool::Bubblewrap,
            OsStr::new("/bin"),
            Some(OsStr::new(selector)),
        )
        .unwrap_err();
        assert!(
            error.to_string().contains("absolute"),
            "{selector:?}: {error}"
        );
    }
}
#[test]
fn actual_owned_nonroot_writable_nonexecutable_and_directory_metadata_refuse() {
    // Real filesystem denials only. Qualification of a root-readonly Nix tool
    // belongs to the guarded hosted prerequisite, not a portable unit fixture.
    let root = Fixture::new();
    let own = root.file("readonly-tool", 0o555);
    assert_ne!(
        fs::metadata(&own).unwrap().uid(),
        0,
        "unprivileged test owner required"
    );
    assert!(trusted_store_tool(&own).is_err());
    let writable = root.file("writable-tool", 0o777);
    assert!(trusted_store_tool(&writable).is_err());
    let nonexecutable = root.file("nonexecutable-tool", 0o444);
    assert!(trusted_store_tool(&nonexecutable).is_err());
    assert!(trusted_store_tool(&root.0).is_err());
}
