use super::*;
use crate::{
    engine_metadata::EngineBootstrap,
    installed_worker_engine::InstalledWorkerEngine,
    worker_runtime::WorkerRuntime,
    worker_storage::{LaunchStorage, StorageOwnerError},
};
use reverie_contracts::worker_config::{self, EffectiveWorkerConfig};
use reverie_core::{
    ids::ProfileSessionId,
    resources::{BudgetMode, CpuQuota, ResourcePolicy},
    worker_schema::{WorkerBase, WorkerIds},
};
use serde_json::json;
use std::{
    collections::BTreeMap,
    os::unix::fs::{PermissionsExt, symlink},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
const SID: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
struct Fixture {
    root: PathBuf,
    runtime: WorkerRuntime,
    storage: Option<LaunchStorage>,
}
impl Fixture {
    fn new() -> Self {
        let root = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!(
                "scratch-label-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(root.join("company.json"), b"{\"employees\":[]}").unwrap();
        fs::set_permissions(root.join("company.json"), fs::Permissions::from_mode(0o600)).unwrap();
        let info = fs::metadata(&root).unwrap();
        let base = WorkerBase::try_new(
            "label-fixture".into(),
            "label-server".into(),
            format!("sha256:{}", "a".repeat(64)),
            WorkerIds::try_new(info.uid(), info.gid()).unwrap(),
            4,
            ResourcePolicy::try_new(
                BudgetMode::Pool,
                0,
                128,
                CpuQuota::from_integer(0).unwrap(),
                4096,
                1024,
            )
            .unwrap(),
        )
        .unwrap();
        let bootstrap = EngineBootstrap::from_service(
            std::env::current_exe().unwrap().as_os_str(),
            BTreeMap::new(),
            root.clone(),
        )
        .unwrap();
        let runtime = WorkerRuntime::new(InstalledWorkerEngine::new(bootstrap), &base);
        let source:EffectiveWorkerConfig=worker_config::decode(&serde_json::to_vec(&json!({"uid":info.uid(),"gid":info.gid(),"deployment":"label-fixture","serverContainer":"label-server","maxWorkers":4,"companyFile":root.join("company.json"),"stateRoot":root.join("state"),"scratchRoot":root.join("scratch"),"mounts":[]})).unwrap()).unwrap();
        let sid = ProfileSessionId::parse(SID).unwrap();
        let mut storage = runtime
            .resolve_storage(&source, &sid)
            .unwrap()
            .into_legacy()
            .unwrap();
        storage.prepare_storage().unwrap();
        storage.prepare_temporary().unwrap();
        HOOKS.with(|slot| slot.borrow_mut().clock = Some(1.25));
        Self {
            root,
            runtime,
            storage: Some(storage),
        }
    }
    fn leaf(&self) -> PathBuf {
        self.storage.as_ref().unwrap().paths().scratch().join(LEAF)
    }
    fn write(&mut self) -> std::result::Result<LabelDisposition, StorageOwnerError> {
        self.storage.as_mut().unwrap().write_scratch_label()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        HOOKS.with(|slot| *slot.borrow_mut() = Hooks::default());
        self.storage
            .take()
            .unwrap()
            .close(Instant::now() + Duration::from_secs(2))
            .unwrap();
        self.runtime
            .close(Instant::now() + Duration::from_secs(2))
            .unwrap();
        fs::remove_dir_all(&self.root).unwrap();
    }
}
#[test]
fn absent_leaf_creates_exact_original_label_and_second_call_preserves_bytes() {
    let mut fixture = Fixture::new();
    let result = fixture.write().unwrap();
    let bytes = fs::read(fixture.leaf()).unwrap();
    HOOKS.with(|slot| slot.borrow_mut().clock = Some(f64::NAN));
    let second = fixture.write().unwrap();
    let after = fs::read(fixture.leaf()).unwrap();
    assert_eq!(result, LabelDisposition::Created);
    assert_eq!(second, LabelDisposition::Preserved);
    assert_eq!(bytes,format!("{{\"ownerSessionId\": \"{SID}\", \"purpose\": \"Laptop scratch; release leased tasks with a handoff before pruning\", \"createdAt\": 1.25}}").as_bytes());
    assert_eq!(bytes, after);
}
#[test]
fn every_occupied_leaf_is_preserved_without_following_or_reading_target() {
    for kind in [
        "regular",
        "directory",
        "dangling",
        "symlink",
        "hardlink",
        "fifo",
    ] {
        let mut fixture = Fixture::new();
        let leaf = fixture.leaf();
        let foreign = fixture.root.join("foreign");
        match kind {
            "regular" => fs::write(&leaf, b"owner text").unwrap(),
            "directory" => fs::create_dir(&leaf).unwrap(),
            "dangling" => symlink(&foreign, &leaf).unwrap(),
            "symlink" => {
                fs::write(&foreign, b"foreign text").unwrap();
                symlink(&foreign, &leaf).unwrap();
            }
            "hardlink" => {
                fs::write(&foreign, b"foreign text").unwrap();
                fs::hard_link(&foreign, &leaf).unwrap();
            }
            "fifo" => nix::unistd::mkfifo(
                &leaf,
                nix::sys::stat::Mode::S_IRUSR | nix::sys::stat::Mode::S_IWUSR,
            )
            .unwrap(),
            _ => unreachable!(),
        }
        let original = fs::symlink_metadata(&leaf).unwrap();
        HOOKS.with(|slot| slot.borrow_mut().clock = Some(f64::NAN));
        let result = fixture.write().unwrap();
        let after = fs::symlink_metadata(&leaf).unwrap();
        assert_eq!(result, LabelDisposition::Preserved, "{kind}");
        assert_eq!(
            (original.dev(), original.ino()),
            (after.dev(), after.ino()),
            "{kind}"
        );
        if matches!(kind, "symlink" | "hardlink") {
            assert_eq!(fs::read(&foreign).unwrap(), b"foreign text");
        }
        if kind == "dangling" {
            assert!(!foreign.exists());
            assert!(fs::symlink_metadata(&leaf).unwrap().is_symlink());
        }
        if kind == "regular" {
            assert_eq!(fs::read(&leaf).unwrap(), b"owner text");
        }
    }
}
#[test]
fn new_occupied_entry_wins_atomic_creation_race_and_is_never_overwritten() {
    let mut fixture = Fixture::new();
    let leaf = fixture.leaf();
    let destination = leaf.clone();
    HOOKS.with(|slot| {
        slot.borrow_mut().before_create = Some(Box::new(move || {
            fs::write(destination, b"race winner").unwrap()
        }))
    });
    let result = fixture.write().unwrap();
    assert_eq!(result, LabelDisposition::Preserved);
    assert_eq!(fs::read(&leaf).unwrap(), b"race winner");
}
#[test]
fn replacement_after_write_remains_untouched_and_owned_partial_is_not_unlinked() {
    let mut fixture = Fixture::new();
    let leaf = fixture.leaf();
    let displaced = fixture.root.join("own-written-label");
    let original = displaced.clone();
    let destination = leaf.clone();
    HOOKS.with(|slot| {
        slot.borrow_mut().after_write = Some(Box::new(move || {
            fs::rename(&destination, original).unwrap();
            fs::write(destination, b"foreign replacement").unwrap();
        }))
    });
    let error = fixture.write().unwrap_err();
    assert!(matches!(error,StorageOwnerError::Storage(ref error) if error.may_have_effects()));
    assert_eq!(fs::read(&leaf).unwrap(), b"foreign replacement");
    assert!(
        fs::read(displaced)
            .unwrap()
            .starts_with(b"{\"ownerSessionId\"")
    );
}
#[test]
fn real_partial_write_and_consumed_close_failure_preserve_both_typed_causes_and_partial_entry() {
    let mut fixture = Fixture::new();
    HOOKS.with(|slot| {
        let mut h = slot.borrow_mut();
        h.partial_write = true;
        h.close_error = true;
    });
    let error = fixture.write().unwrap_err();
    let StorageOwnerError::Storage(StorageError::PartialEffects(error)) = error else {
        panic!("missing partial outcome")
    };
    let StorageError::Finalization { primary, secondary } = *error else {
        panic!("missing typed primary and close failure")
    };
    assert!(
        matches!(*primary,StorageError::Io(ref error) if error.raw_os_error()==Some(libc::ENOSPC))
    );
    assert!(
        matches!(*secondary,StorageError::Io(ref error) if error.raw_os_error()==Some(libc::EIO))
    );
    assert_eq!(fs::read(fixture.leaf()).unwrap(), b"{");
}
