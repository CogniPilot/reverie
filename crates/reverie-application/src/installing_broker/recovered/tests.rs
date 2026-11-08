//! Full real bootstrap/recovery transaction with an owned closed-query Rust
//! child. No business callback, fake Runtime, live company or engine.
#[path = "lifetime_tests.rs"]
mod lifetime;
#[path = "reserved_tests.rs"]
mod reserved;
use super::*;
use reverie_host::{
    engine_metadata::EngineBootstrap, installed_worker_engine::InstalledWorkerEngine,
    worker_runtime::WorkerRuntime,
};
use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        OnceLock,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
static PROGRAM: OnceLock<PathBuf> = OnceLock::new();
static NEXT: AtomicU64 = AtomicU64::new(0);
const FIRST: &str = "11111111-2222-3333-4444-555555555555";
const SECOND: &str = "22222222-2222-3333-4444-555555555555";
pub(in crate::installing_broker) fn program() -> &'static Path {
    PROGRAM.get_or_init(|| {
        let root = crate::test_process::fixture_directory("recovery-child-build");
        let source = root.join("child.rs");
        fs::write(
            &source,
            include_str!("../../../tests/support/worker_recovery_child.rs"),
        )
        .unwrap();
        let binary = root.join("child");
        assert!(
            Command::new("rustc")
                .args(["--edition=2024", "-o"])
                .arg(&binary)
                .arg(&source)
                .status()
                .unwrap()
                .success()
        );
        binary
    })
}
pub(in crate::installing_broker) struct Tree {
    pub(in crate::installing_broker) root: PathBuf,
    pub(in crate::installing_broker) broker: InstallingBroker,
}
impl Tree {
    pub(in crate::installing_broker) fn new(names: &str) -> Self {
        Self::with_budget(names, "pool", 0, 4096)
    }
    fn with_budget(names: &str, mode: &str, memory: u32, pool: u32) -> Self {
        let (root, broker) = Self::bootstrap_parts(names, mode, memory, pool);
        Self { root, broker }
    }
    pub(in crate::installing_broker) fn bootstrap_parts(
        names: &str,
        mode: &str,
        memory: u32,
        pool: u32,
    ) -> (PathBuf, InstallingBroker) {
        let _ = program();
        let root = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!(
                "worker-recovery-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::AcqRel)
            ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        fs::create_dir(root.join("work")).unwrap();
        fs::write(root.join("company.json"), b"{\"employees\":[]}").unwrap();
        fs::set_permissions(root.join("company.json"), fs::Permissions::from_mode(0o600)).unwrap();
        fs::write(root.join("names.out"), names).unwrap();
        fs::write(root.join("ids.out"), "").unwrap();
        let metadata = fs::metadata(&root).unwrap();
        let mut data: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../reverie-contracts/tests/fixtures/broker-laptop-python.json"
        ))
        .unwrap();
        let source = &mut data["configuration"];
        for (key, relative) in [
            ("companyFile", "company.json"),
            ("companyRoot", "company"),
            ("stateRoot", "state"),
            ("scratchRoot", "scratch"),
            ("apiSocketRoot", "office"),
            ("socket", "control/broker.sock"),
        ] {
            source[key] = serde_json::json!(root.join(relative));
        }
        source["mounts"][0]["source"] = serde_json::json!(root.join("work"));
        source["uid"] = serde_json::json!(metadata.uid());
        source["gid"] = serde_json::json!(metadata.gid());
        source["budgetMode"] = serde_json::json!(mode);
        source["memoryMiB"] = serde_json::json!(memory);
        source["poolMemoryMiB"] = serde_json::json!(pool);
        let config =
            reverie_contracts::worker_config::decode(&serde_json::to_vec(source).unwrap()).unwrap();
        let snapshot = crate::worker_validation::validate_captured(config).unwrap();
        let bootstrap =
            EngineBootstrap::from_service(program().as_os_str(), BTreeMap::new(), root.clone())
                .unwrap();
        let runtime = WorkerRuntime::new(
            InstalledWorkerEngine::new(bootstrap),
            snapshot.envelope().base(),
        );
        let broker = InstallingBroker::new(snapshot, runtime)
            .unwrap_or_else(|failure| panic!("genuine bootstrap failed: {}", failure.code()));
        (root, broker)
    }
    fn calls(&self) -> Vec<String> {
        fs::read_to_string(self.root.join("calls.txt"))
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect()
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        if let Some(office) = self.broker.recovery.office.lock().unwrap().as_ref() {
            office
                .close(Instant::now() + Duration::from_secs(5))
                .unwrap();
        }
        self.broker
            .storage
            .runtime
            .close(Instant::now() + Duration::from_secs(5))
            .unwrap();
        fs::remove_dir_all(&self.root).unwrap();
    }
}
#[test]
fn actual_unreserved_recovery_registers_owned_legacy_phones_without_lease_trees_or_eager_inspect() {
    let tree = Tree::new(&format!(
        "test-agent-{FIRST}\n00000000-0000-0000-0000-000000000000\n"
    ));
    assert!(tree.broker.resource_reservations().unwrap().is_none());
    assert!(tree.broker.recovery.office.lock().unwrap().is_none());
    let summary = tree.broker.recover_laptops().unwrap();
    assert_eq!(summary.selected(), 2);
    assert_eq!(summary.registered(), 2);
    let life = tree.broker.installed.lifecycle().unwrap();
    let names = life
        .entries()
        .map(|(sid, name)| (sid.as_str().to_owned(), name.as_str().to_owned()))
        .collect::<Vec<_>>();
    assert_eq!(
        names,
        vec![
            (FIRST.to_owned(), format!("test-agent-{FIRST}")),
            (
                "00000000-0000-0000-0000-000000000000".to_owned(),
                "00000000-0000-0000-0000-000000000000".to_owned()
            )
        ]
    );
    for entry in &*life.guard {
        let LaptopOwner::Recovered(owner) = &entry.owner else {
            panic!("actual recovery owner")
        };
        assert_eq!(owner.storage.paths().kind(), StorageKind::Session);
        assert!(
            fs::symlink_metadata(
                tree.root
                    .join("office")
                    .join(entry.session.as_str())
                    .join("office.sock")
            )
            .unwrap()
            .file_type()
            .is_socket()
        );
    }
    drop(life);
    assert!(!tree.root.join("state").exists());
    assert!(!tree.root.join("scratch").exists());
    assert_eq!(
        tree.calls(),
        vec!["ps\0--filter\0label=reverie.worker=test\0--format\0{{.Names}}"]
    );
}
#[test]
fn all_real_phone_constructors_succeed_before_registry_commit_and_failed_attempt_is_reusable() {
    let tree = Tree::new(&format!("test-agent-{FIRST}\ntest-agent-{SECOND}\n"));
    let occupied = tree.root.join("office").join(SECOND);
    fs::create_dir_all(&occupied).unwrap();
    fs::set_permissions(&occupied, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(occupied.join("office.sock"), "owner occupied leaf").unwrap();
    assert!(tree.broker.recover_laptops().is_err());
    assert_eq!(tree.broker.installed.lifecycle().unwrap().guard.len(), 0);
    assert!(
        !tree
            .root
            .join("office")
            .join(FIRST)
            .join("office.sock")
            .exists()
    );
    assert_eq!(
        fs::read_to_string(occupied.join("office.sock")).unwrap(),
        "owner occupied leaf"
    );
    assert!(!tree.root.join("state").exists());
    fs::remove_file(occupied.join("office.sock")).unwrap();
    let result = tree.broker.recover_laptops().unwrap();
    assert_eq!(result.registered(), 2);
    assert_eq!(tree.calls().len(), 2);
}
#[test]
fn duplicate_ignored_names_refuse_before_any_phone_or_lease_and_no_empty_registry_credit() {
    let tree = Tree::new("unrelated\nunrelated\n");
    assert!(tree.broker.recover_laptops().is_err());
    assert!(tree.broker.installed.lifecycle().unwrap().guard.is_empty());
    assert!(tree.broker.recovery.office.lock().unwrap().is_none());
    assert!(!tree.root.join("office").exists());
    assert!(!tree.root.join("state").exists());
    assert_eq!(tree.calls().len(), 1);
}
#[test]
fn modeled_name_without_actual_office_or_storage_cannot_qualify_real_recovery() {
    let tree = Tree::new("");
    tree.broker
        .installed
        .model_laptop(ProfileSessionId::parse(FIRST).unwrap());
    assert!(matches!(
        tree.broker.recover_laptops(),
        Err(RecoveryError::Refused(
            "WORKER_MODELED_REGISTRATION_IS_NOT_RECOVERY_OWNER"
        ))
    ));
    assert!(tree.broker.recovery.office.lock().unwrap().is_none());
    assert!(!tree.root.join("office").exists());
    assert!(
        tree.calls().is_empty(),
        "modeled fixture supplies no real registration producer"
    );
}
#[test]
fn actual_recovered_admission_budget_refuses_before_storage_claims_and_phones() {
    let tree = Tree::with_budget(
        &format!("test-agent-{FIRST}\ntest-agent-{SECOND}\n"),
        "admission",
        512,
        512,
    );
    assert!(tree.broker.recover_laptops().is_err());
    assert!(tree.broker.installed.lifecycle().unwrap().guard.is_empty());
    assert!(tree.broker.recovery.office.lock().unwrap().is_none());
    assert!(!tree.root.join("state").exists());
    assert!(!tree.root.join("office").exists());
    assert_eq!(tree.calls().len(), 1);
}
#[test]
fn second_actual_storage_projection_failure_precedes_first_office_constructor() {
    let tree = Tree::new(&format!("test-agent-{FIRST}\ntest-agent-{SECOND}\n"));
    let selected = tree.root.join("state").join(SECOND);
    fs::create_dir_all(&selected).unwrap();
    for directory in [tree.root.join("state"), selected.clone()] {
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).unwrap();
    }
    fs::write(selected.join("storage-owner.json"), b"{}").unwrap();
    fs::set_permissions(
        selected.join("storage-owner.json"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    assert!(tree.broker.recover_laptops().is_err());
    assert!(tree.broker.installed.lifecycle().unwrap().guard.is_empty());
    assert!(tree.broker.recovery.office.lock().unwrap().is_none());
    assert!(!tree.root.join("office").exists());
    assert!(
        !tree.root.join("state/storage-locks").exists(),
        "legacy claim creates no invented lock tree"
    );
    assert_eq!(
        fs::read(selected.join("storage-owner.json")).unwrap(),
        b"{}"
    );
    assert_eq!(tree.calls().len(), 1);
}
