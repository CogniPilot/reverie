use super::*;
use reverie_contracts::worker_config;
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    fs as stdfs,
    os::unix::fs::{MetadataExt, PermissionsExt, symlink},
    sync::atomic::{AtomicU64, Ordering},
};
mod compatibility;
const E: &str = "11111111-2222-4333-8444-555555555555";
const A: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const B: &str = "00000000-0000-0000-0000-000000000000";
static NEXT: AtomicU64 = AtomicU64::new(0);
type Hook = Box<dyn FnOnce(&Path) -> Result<()>>;
thread_local! { static PUBLISH:RefCell<Option<Hook>>=RefCell::new(None); }
pub(super) fn publication_written(path: &Path) -> Result<()> {
    PUBLISH
        .with(|slot| slot.borrow_mut().take())
        .map_or(Ok(()), |hook| hook(path))
}
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let root = stdfs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!(
                "storage-lease-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        stdfs::create_dir(&root).unwrap();
        stdfs::set_permissions(&root, stdfs::Permissions::from_mode(0o700)).unwrap();
        let tree = Self(root);
        tree.company(A, "null", true);
        tree
    }
    fn state(&self) -> PathBuf {
        self.0.join("state")
    }
    fn employee(&self) -> PathBuf {
        self.state().join("employees").join(E)
    }
    fn raw(&self) -> Value {
        json!({"uid":native::uid(),"companyFile":self.0.join("company.json"),"stateRoot":self.state(),"scratchRoot":self.0.join("scratch"),"mounts":[]})
    }
    fn config(&self) -> EffectiveWorkerConfig {
        config(self.raw())
    }
    fn write(&self, name: &Path, raw: &[u8]) {
        stdfs::write(name, raw).unwrap();
        stdfs::set_permissions(name, stdfs::Permissions::from_mode(0o600)).unwrap();
    }
    fn company(&self, sid: &str, owner: &str, running: bool) {
        self.write(&self.0.join("company.json"), format!("{{\"employees\":[{{\"id\":\"{E}\",\"sessionId\":\"{sid}\",\"owner\":{owner},\"desiredRunning\":{running}}}]}}").as_bytes());
    }
    fn journal(&self, phase: &str) {
        self.write(&self.0.join("plan-moves.json"), format!("[{{\"employeeId\":\"{E}\",\"owner\":null,\"oldSession\":\"{A}\",\"newSession\":\"{B}\",\"phase\":\"{phase}\"}}]").as_bytes());
    }
    fn mkdir(&self, path: &Path) {
        stdfs::create_dir_all(path).unwrap();
        let mut current = path;
        while current.starts_with(&self.0) {
            stdfs::set_permissions(current, stdfs::Permissions::from_mode(0o700)).unwrap();
            let Some(parent) = current.parent() else {
                break;
            };
            current = parent;
        }
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        PUBLISH.with(|slot| *slot.borrow_mut() = None);
        native::test_faults::set(None, false);
        stdfs::remove_dir_all(&self.0).unwrap();
    }
}
fn config(value: Value) -> EffectiveWorkerConfig {
    worker_config::decode(&serde_json::to_vec(&value).unwrap()).unwrap()
}
fn session(sid: &str) -> ProfileSessionId {
    ProfileSessionId::parse(sid).unwrap()
}
fn acquire(tree: &Tree) -> StorageLease {
    StorageLease::acquire_launch(&tree.config(), &session(A)).unwrap()
}

#[test]
fn employee_preparation_publishes_exact_bytes_and_preserves_existing_home() {
    let tree = Tree::new();
    let mut lease = acquire(&tree);
    lease.prepare_storage().unwrap();
    let marker = stdfs::read(tree.employee().join("storage.json")).unwrap();
    assert_eq!(marker, format!("{{\"identity\": \"{E}\", \"kind\": \"employee\", \"state\": \"ready\", \"version\": 1}}").as_bytes());
    tree.write(
        &lease.paths().home().join("preserved"),
        b"unique owned data",
    );
    lease.prepare_storage().unwrap();
    validate_storage(&tree.config(), lease.paths()).unwrap();
    assert_eq!(
        stdfs::read(lease.paths().home().join("preserved")).unwrap(),
        b"unique owned data"
    );
    lease.close().unwrap();
}
#[test]
fn migration_and_all_transports_share_exclusive_employee_lock() {
    let tree = Tree::new();
    tree.journal("completed");
    let lease = acquire(&tree);
    for sid in [A, B] {
        assert!(StorageLease::acquire_launch(&tree.config(), &session(sid)).is_err());
        assert!(StorageLease::acquire_migration(&tree.config(), &session(sid)).is_err());
    }
    let paths = lock_paths(&tree.config(), lease.paths()).unwrap();
    tree.write(paths.migration_fence(), b"migration required");
    lease.close().unwrap();
    for sid in [A, B] {
        assert!(StorageLease::acquire_launch(&tree.config(), &session(sid)).is_err());
    }
    StorageLease::acquire_migration(&tree.config(), &session(B))
        .unwrap()
        .close()
        .unwrap();
}
#[test]
fn ad_hoc_nil_session_is_independent_and_creates_neither_nix_nor_marker() {
    let tree = Tree::new();
    let employee = acquire(&tree);
    let mut adhoc = StorageLease::acquire_launch(&tree.config(), &session(B)).unwrap();
    adhoc.prepare_storage().unwrap();
    adhoc.record_storage_binding().unwrap();
    assert!(adhoc.paths().home().is_dir());
    assert!(!adhoc.paths().nix().exists());
    assert!(!adhoc.paths().root().join("storage.json").exists());
    assert!(!adhoc.paths().root().join("storage-owner.json").exists());
    adhoc.close().unwrap();
    employee.close().unwrap();
}
#[test]
fn old_home_nix_and_scratch_nix_never_initialize_an_empty_employee() {
    for name in ["home", "nix", "scratch-nix", "old-home"] {
        let tree = Tree::new();
        tree.journal("completed");
        let legacy = match name {
            "scratch-nix" => tree.0.join("scratch").join(A).join("nix"),
            "old-home" => tree.state().join(B).join("home"),
            other => tree.state().join(A).join(other),
        };
        tree.mkdir(&legacy);
        tree.write(&legacy.join("original"), b"retain me");
        let mut lease = acquire(&tree);
        assert!(lease.prepare_storage().is_err());
        assert!(!tree.employee().exists());
        assert_eq!(stdfs::read(legacy.join("original")).unwrap(), b"retain me");
        lease.close().unwrap();
    }
}
#[test]
fn dangling_legacy_and_marker_links_refuse_without_touching_target() {
    let tree = Tree::new();
    tree.mkdir(&tree.state().join(A));
    symlink(tree.0.join("absent"), tree.state().join(A).join("home")).unwrap();
    let mut lease = acquire(&tree);
    assert!(lease.prepare_storage().is_err());
    tree.mkdir(&tree.employee());
    symlink(tree.0.join("absent"), tree.employee().join("storage.json")).unwrap();
    assert!(lease.prepare_storage().is_err());
    assert!(!tree.0.join("absent").exists());
    lease.close().unwrap();
}
#[test]
fn publication_never_repairs_foreign_marker_or_missing_paired_directory() {
    for raw in ["{}", "{\"identity\":\"foreign\",\"version\":1}"] {
        let tree = Tree::new();
        let mut lease = acquire(&tree);
        tree.mkdir(&tree.employee());
        tree.write(&tree.employee().join("storage.json"), raw.as_bytes());
        assert!(lease.prepare_storage().is_err());
        assert_eq!(
            stdfs::read(tree.employee().join("storage.json")).unwrap(),
            raw.as_bytes()
        );
        lease.close().unwrap();
    }
    let tree = Tree::new();
    let mut lease = acquire(&tree);
    lease.prepare_storage().unwrap();
    stdfs::remove_dir(lease.paths().nix()).unwrap();
    assert!(lease.prepare_storage().is_err());
    assert!(!lease.paths().nix().exists());
    lease.close().unwrap();
}
#[test]
fn stable_lock_refuses_symlink_hardlink_fifo_and_public_modes() {
    for kind in ["symlink", "hardlink", "fifo", "public"] {
        let tree = Tree::new();
        let lease = acquire(&tree);
        let lock = lock_paths(&tree.config(), lease.paths())
            .unwrap()
            .lock()
            .to_owned();
        lease.close().unwrap();
        stdfs::remove_file(&lock).unwrap();
        let sentinel = tree.0.join("sentinel");
        tree.write(&sentinel, b"foreign bytes");
        match kind {
            "symlink" => symlink(&sentinel, &lock).unwrap(),
            "hardlink" => stdfs::hard_link(&sentinel, &lock).unwrap(),
            "fifo" => nix::unistd::mkfifo(
                &lock,
                nix::sys::stat::Mode::S_IRUSR | nix::sys::stat::Mode::S_IWUSR,
            )
            .unwrap(),
            _ => {
                tree.write(&lock, b"");
                stdfs::set_permissions(&lock, stdfs::Permissions::from_mode(0o644)).unwrap();
            }
        }
        assert!(StorageLease::acquire_launch(&tree.config(), &session(A)).is_err());
        assert_eq!(stdfs::read(sentinel).unwrap(), b"foreign bytes");
    }
}
#[test]
fn unrelated_resource_maps_are_not_a_storage_validation_gate() {
    let tree = Tree::new();
    let mut raw = tree.raw();
    raw["employeeResources"] = json!({"malformed":"not resources"});
    raw["poolMemoryMiB"] = json!(false);
    let mut lease = StorageLease::acquire_launch(&config(raw), &session(A)).unwrap();
    lease.prepare_storage().unwrap();
    lease.close().unwrap();
}
#[test]
fn root_overlap_and_shared_mounts_refuse_before_state_creation() {
    for kind in ["equal", "under", "mount"] {
        let tree = Tree::new();
        let mut raw = tree.raw();
        match kind {
            "equal" => raw["scratchRoot"] = raw["stateRoot"].clone(),
            "under" => raw["scratchRoot"] = json!(tree.0),
            _ => raw["mounts"] = json!([{"source":tree.0}]),
        }
        assert!(StorageLease::acquire_launch(&config(raw), &session(A)).is_err());
        assert!(!tree.state().exists());
    }
}
#[test]
fn owner_private_modes_are_not_narrowed_to_exact_0700() {
    let tree = Tree::new();
    let lease = acquire(&tree);
    let locks = tree.state().join("storage-locks");
    stdfs::set_permissions(&locks, stdfs::Permissions::from_mode(0o500)).unwrap();
    assert!(lock_paths(&tree.config(), lease.paths()).is_ok());
    stdfs::set_permissions(&locks, stdfs::Permissions::from_mode(0o700)).unwrap();
    lease.close().unwrap();
}
#[test]
fn off_current_lineage_survives_journal_pruning_and_rejects_historical_publication() {
    let tree = Tree::new();
    tree.journal("completed");
    tree.company(A, "null", false);
    let mut lease = acquire(&tree);
    lease.prepare_storage().unwrap();
    lease.record_storage_binding().unwrap();
    let marker = tree.state().join(A).join("storage-owner.json");
    let saved = stdfs::read(&marker).unwrap();
    lease.record_storage_binding().unwrap();
    assert_eq!(stdfs::read(&marker).unwrap(), saved);
    lease.close().unwrap();
    tree.company(B, "null", false);
    stdfs::remove_file(tree.0.join("plan-moves.json")).unwrap();
    let mut old = acquire(&tree);
    assert_eq!(old.paths().identity(), E);
    assert!(old.record_storage_binding().is_err());
    assert_eq!(stdfs::read(&marker).unwrap(), saved);
    old.close().unwrap();
}
#[test]
fn rebound_lock_and_rebound_directory_are_refused_and_foreign_bytes_remain() {
    let tree = Tree::new();
    let mut lease = acquire(&tree);
    let lock = lock_paths(&tree.config(), lease.paths())
        .unwrap()
        .lock()
        .to_owned();
    stdfs::rename(&lock, lock.with_extension("old")).unwrap();
    tree.write(&lock, b"replacement");
    assert!(lease.prepare_storage().is_err());
    assert!(lease.close().is_err());
    assert_eq!(stdfs::read(lock).unwrap(), b"replacement");
}
#[test]
fn publication_fault_retains_visible_bytes_and_reports_possible_effects() {
    let tree = Tree::new();
    let mut lease = acquire(&tree);
    PUBLISH.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(|path| {
            assert!(path.exists());
            Err(std::io::Error::other("owned post-write failure").into())
        }))
    });
    let error = lease.prepare_storage().unwrap_err();
    assert!(error.may_have_effects());
    assert!(tree.employee().join("storage.json").is_file());
    lease.close().unwrap();
}
#[test]
fn close_failure_is_checked_and_never_retried_on_reused_descriptor() {
    let tree = Tree::new();
    let lease = acquire(&tree);
    let lock = lock_paths(&tree.config(), lease.paths())
        .unwrap()
        .lock()
        .to_owned();
    let ino = stdfs::metadata(lock).unwrap().ino();
    assert!(ino > 0);
    native::test_faults::set(None, true);
    assert!(lease.close().is_err());
}

#[test]
fn checked_writer_close_retains_primary_failure_and_publication_evidence() {
    let tree = Tree::new();
    let mut lease = acquire(&tree);
    PUBLISH.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(|_| {
            native::test_faults::set(None, true);
            Err(std::io::Error::other("primary publication failure").into())
        }))
    });
    let error = lease.prepare_storage().unwrap_err();
    assert!(error.may_have_effects());
    let message = format!("{error:?}");
    assert!(message.contains("primary publication failure"));
    assert!(message.contains("owned injected close failure"));
    assert!(tree.employee().join("storage.json").is_file());
    lease.close().unwrap();
}
#[test]
fn marker_replacement_keeps_foreign_entry_and_never_claims_publication_success() {
    let tree = Tree::new();
    let mut lease = acquire(&tree);
    PUBLISH.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(|path| {
            let held = stdfs::metadata(path)?.ino();
            stdfs::remove_file(path)?;
            stdfs::write(path, b"foreign replacement")?;
            assert_ne!(stdfs::metadata(path)?.ino(), held);
            Ok(())
        }))
    });
    assert!(lease.prepare_storage().unwrap_err().may_have_effects());
    assert_eq!(
        stdfs::read(tree.employee().join("storage.json")).unwrap(),
        b"foreign replacement"
    );
    lease.close().unwrap();
}
#[test]
fn pinned_directory_refuses_rebound_name_before_any_new_publication() {
    let tree = Tree::new();
    tree.mkdir(&tree.state());
    let held = Directory::open(&tree.state(), native::uid()).unwrap();
    stdfs::rename(tree.state(), tree.0.join("original-state")).unwrap();
    tree.mkdir(&tree.state());
    tree.write(&tree.state().join("foreign"), b"retained");
    let mut effects = false;
    assert!(
        held.publish(
            std::ffi::OsStr::new("storage.json"),
            b"not published",
            &mut effects
        )
        .is_err()
    );
    assert!(!effects);
    assert!(!tree.state().join("storage.json").exists());
    assert_eq!(
        stdfs::read(tree.state().join("foreign")).unwrap(),
        b"retained"
    );
    held.close().unwrap();
}
#[test]
fn fresh_binding_check_precedes_storage_preparation_mutations() {
    let tree = Tree::new();
    let mut lease = acquire(&tree);
    tree.company(A, "\"new owner\"", true);
    let error = lease.prepare_storage().unwrap_err();
    assert!(!error.may_have_effects());
    assert!(!tree.employee().exists());
    assert!(lease.record_storage_binding().is_err());
    assert!(!tree.state().join(A).exists());
    lease.close().unwrap();
}
