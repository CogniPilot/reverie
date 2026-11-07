use super::*;
#[path = "tests_draft.rs"]
mod draft_cases;
#[path = "tests_optional.rs"]
mod optional_cases;
use reverie_contracts::{reservation_control::domain_digest, worker_config};
use std::{
    os::unix::fs::{PermissionsExt, symlink},
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Tree {
    root: PathBuf,
    config: ReservationConfiguration,
}
impl Tree {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "reverie-control-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        for path in [
            &root,
            &root.join("state"),
            &root.join("control"),
            &root.join("control/profiles"),
            &root.join("control/operations"),
        ] {
            if path != &root {
                fs::create_dir(path).unwrap();
            }
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let value = serde_json::json!({"resourceReservations":{"directory":root.join("control"),"companyId":"11111111-2222-4333-8444-555555555555","poolId":"22222222-2222-4333-8444-555555555555","ownerScopeDigest":"d".repeat(64),"hostReserveMiB":1},"stateRoot":root.join("state"),"uid":fs::metadata(&root).unwrap().uid(),"image":"old"});
        let config = ReservationConfiguration::capture(
            worker_config::decode(&serde_json::to_vec(&value).unwrap()).unwrap(),
        );
        let tree = Self { root, config };
        for name in [
            "control/admission.lock",
            "control/profiles/profiles.lock",
            "control/operations/operations.lock",
            "control/operations/operations.json",
        ] {
            tree.write(name, b"{}");
        }
        tree.marker(&[".", "profiles", "operations"]);
        tree
    }
    fn write(&self, name: &str, raw: &[u8]) {
        let path = self.root.join(name);
        fs::write(&path, raw).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    fn identity(&self, name: &str) -> String {
        let info = fs::symlink_metadata(self.root.join(name)).unwrap();
        format!("[{},{}]", info.dev(), info.ino())
    }
    fn marker(&self, order: &[&str]) {
        let mut directories = Vec::new();
        for name in order {
            let path = if *name == "." {
                "control".to_owned()
            } else {
                format!("control/{name}")
            };
            directories.push(format!(
                "{}:{}",
                serde_json::to_string(name).unwrap(),
                self.identity(&path)
            ));
        }
        let config: serde_json::Value =
            serde_json::from_slice(&worker_config::encode_config(self.config.configuration()))
                .unwrap();
        let raw = format!(
            "{{\"schema\":\"reverie-resource-control-v1\",\"state\":\"READY\",\"option\":{},\"directories\":{{{}}},\"admissionLock\":{},\"stateDirectory\":{},\"locks\":{{\"profiles\":{},\"operations\":{}}},\"configurationDigest\":\"{}\"}}",
            config["resourceReservations"],
            directories.join(","),
            self.identity("control/admission.lock"),
            self.identity("state"),
            self.identity("control/profiles/profiles.lock"),
            self.identity("control/operations/operations.lock"),
            domain_digest(self.config.configuration()).unwrap().to_hex()
        );
        self.write("state/resource-reservation-control.json", raw.as_bytes());
    }
    fn binding(&self) -> ControlBinding {
        ControlBinding::from_metadata(
            &read_marker(&self.config).unwrap(),
            self.config.configuration(),
        )
        .unwrap()
    }
    fn mode(&self, name: &str, mode: u32) {
        fs::set_permissions(self.root.join(name), fs::Permissions::from_mode(mode)).unwrap();
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        native::test_faults::set(None, false);
        fs::remove_dir_all(&self.root).unwrap();
    }
}

#[test]
fn actual_lock_is_exclusive_and_named_rebind_never_inherits_admission() {
    let tree = Tree::new();
    let binding = tree.binding();
    let mut lock = AdmissionLock::acquire(&tree.config).unwrap();
    guard_layout(&tree.config, &binding, &lock).unwrap();
    assert_eq!(
        AdmissionLock::acquire(&tree.config).err().unwrap().code(),
        "RESERVATION_ADMISSION_LOCK_BUSY"
    );
    fs::rename(
        tree.root.join("control/admission.lock"),
        tree.root.join("control/retained.lock"),
    )
    .unwrap();
    tree.write("control/admission.lock", b"{}");
    assert_eq!(
        lock.assert_current(&tree.config, &binding)
            .unwrap_err()
            .code(),
        "RESERVATION_ADMISSION_LOCK_REBOUND"
    );
    lock.close().unwrap();
    assert_eq!(
        lock.assert_current(&tree.config, &binding)
            .unwrap_err()
            .code(),
        "RESERVATION_ADMISSION_LOCK_REQUIRED"
    );
    lock.close().unwrap();
}
#[test]
fn original_marker_order_selects_the_first_native_directory_failure() {
    let tree = Tree::new();
    let profiles_first = tree.binding();
    tree.marker(&["operations", "profiles", "."]);
    let operations_first = tree.binding();
    let mut lock = AdmissionLock::acquire(&tree.config).unwrap();
    tree.mode("control/profiles", 0o755);
    fs::rename(
        tree.root.join("control/operations"),
        tree.root.join("control/old-operations"),
    )
    .unwrap();
    symlink("old-operations", tree.root.join("control/operations")).unwrap();
    assert_eq!(
        guard_layout(&tree.config, &profiles_first, &lock)
            .unwrap_err()
            .code(),
        "RESERVATION_CONTROL_DIRECTORY"
    );
    assert_eq!(
        guard_layout(&tree.config, &operations_first, &lock)
            .unwrap_err()
            .code(),
        "HOST_ARTIFACT_IO"
    );
    lock.close().unwrap();
}
#[test]
fn private_files_and_optional_unselected_profile_match_source() {
    let tree = Tree::new();
    let binding = tree.binding();
    let mut lock = AdmissionLock::acquire(&tree.config).unwrap();
    // Fresh provisioning intentionally has no profiles.json.
    guard_layout(&tree.config, &binding, &lock).unwrap();
    tree.write("control/profiles/profiles.json", b"{}");
    tree.mode("control/profiles/profiles.json", 0o400);
    assert_eq!(
        guard_layout(&tree.config, &binding, &lock)
            .unwrap_err()
            .code(),
        "RESERVATION_PRIVATE_FILE"
    );
    tree.mode("control/profiles/profiles.json", 0o600);
    fs::hard_link(
        tree.root.join("control/profiles/profiles.lock"),
        tree.root.join("held-profile-lock"),
    )
    .unwrap();
    assert_eq!(
        guard_layout(&tree.config, &binding, &lock)
            .unwrap_err()
            .code(),
        "RESERVATION_PRIVATE_LOCK"
    );
    lock.close().unwrap();
}
#[test]
fn pending_broken_alias_is_present_and_marker_mode_is_exact() {
    let tree = Tree::new();
    assert!(!pending_present(&tree.config).unwrap());
    symlink(
        "absent",
        tree.root.join("state/resource-reservation-control.pending"),
    )
    .unwrap();
    assert!(pending_present(&tree.config).unwrap());
    tree.mode("state/resource-reservation-control.json", 0o400);
    assert_eq!(
        read_marker(&tree.config).err().unwrap().code(),
        "RESERVATION_PRIVATE_FILE"
    );
}
#[test]
fn checked_close_failure_prevents_layout_or_admission_success() {
    if crate::test_process::isolate_case(
        "reservation_control::tests::checked_close_failure_prevents_layout_or_admission_success",
    ) {
        return;
    }
    let tree = Tree::new();
    let binding = tree.binding();
    let mut lock = AdmissionLock::acquire(&tree.config).unwrap();
    native::test_faults::set(None, true);
    assert!(guard_layout(&tree.config, &binding, &lock).is_err());
    native::test_faults::set(None, true);
    assert!(lock.close().is_err());
    assert_eq!(
        lock.assert_current(&tree.config, &binding)
            .unwrap_err()
            .code(),
        "RESERVATION_ADMISSION_LOCK_REQUIRED"
    );
    // The descriptor really closed despite the injected finalizer refusal.
    AdmissionLock::acquire(&tree.config)
        .unwrap()
        .close()
        .unwrap();
}
#[test]
fn control_walk_allows_root_sticky_ancestors_but_never_final_nonprivate_directory() {
    let tree = Tree::new();
    let paths = tree.config.control_paths().unwrap();
    native::control_directory(paths.root(), tree.config.uid().unwrap()).unwrap();
    tree.mode("control", 0o1700);
    assert!(native::control_directory(paths.root(), tree.config.uid().unwrap()).is_err());
    // No unanchored '..', aliases or double-root spelling become custody.
    for suffix in ["control/../control", "control-alias"] {
        if suffix == "control-alias" {
            symlink("control", tree.root.join(suffix)).unwrap();
        }
        let path = PosixPath::from_scalar_text(tree.root.join(suffix).to_str().unwrap());
        assert!(native::control_directory(&path, tree.config.uid().unwrap()).is_err());
    }
    let doubled = PosixPath::from_scalar_text(&format!("/{}", tree.root.display()));
    assert!(native::control_directory(&doubled, tree.config.uid().unwrap()).is_err());
}
