//! Real child-process lock, crash/restart and restrictive-umask tests.
use reverie_contracts::operations_v1;
use reverie_core::operations::*;
use reverie_core::revision::{Generation, ObservedProfileVersion};
use reverie_store::operations::{
    CapacityObserver, ClaimSelection, OperationStore, Result, ScopeGuard,
};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::os::unix::process::ExitStatusExt;
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
fn id(n: u64) -> JournalId {
    JournalId::parse(&format!("{n:08x}-1111-4111-8111-111111111111")).unwrap()
}
fn digest(n: u8) -> JournalDigest {
    JournalDigest::parse(&format!("{n:x}").repeat(64)).unwrap()
}
fn scope() -> OperationScope {
    OperationScope {
        company_id: id(1),
        owner_scope_digest: digest(1),
    }
}
fn observed(employee: &JournalId) -> CapacityObservation {
    CapacityObservation::try_new(ObservationData {
        pool_id: id(6),
        pool_revision_digest: digest(2),
        budget_bytes: 128 * MIB,
        committed_bytes: 100 * MIB,
        employee_id: employee.clone(),
        current_sid: id(7),
        generation: Generation::try_new(1).unwrap(),
        source_binding_digest: digest(3),
        profile_version: ObservedProfileVersion::try_new(1).unwrap(),
        current_memory_bytes: MemoryBytes::try_new(32 * MIB).unwrap(),
    })
    .unwrap()
}
fn request(employee: &JournalId) -> OperationRequest {
    OperationRequest {
        employee_id: employee.clone(),
        pool_id: id(6),
        source_binding_digest: digest(3),
        profile_version: ObservedProfileVersion::try_new(1).unwrap(),
        requested_memory_bytes: MemoryBytes::try_new(48 * MIB).unwrap(),
        preview_digest: digest(4),
        observation_digest: operations_v1::observation_digest(&observed(employee)),
    }
}
struct Guard;
impl ScopeGuard for Guard {
    fn assert_scope(&self, _: &OperationScope) -> Result<()> {
        Ok(())
    }
}
struct Observer {
    crash_root: Option<PathBuf>,
    calls: AtomicUsize,
}
impl CapacityObserver for Observer {
    fn observe(
        &self,
        _: &OperationScope,
        _: &JournalId,
        employee: &JournalId,
    ) -> Result<CapacityObservation> {
        let count = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        if let Some(root) = &self.crash_root
            && count == 3
        {
            fs::write(root.join("installed"), b"held").unwrap();
            await_file(&root.join("never-release"));
        }
        Ok(observed(employee))
    }
}
fn store(root: &Path, crash: bool) -> OperationStore {
    OperationStore::open(
        root,
        Arc::new(Guard),
        Some(Arc::new(Observer {
            crash_root: crash.then(|| root.to_owned()),
            calls: AtomicUsize::new(0),
        })),
    )
    .unwrap()
}
fn await_file(path: &Path) {
    let until = Instant::now() + Duration::from_secs(8);
    while !path.exists() {
        assert!(Instant::now() < until, "child fixture timeout");
        std::thread::sleep(Duration::from_millis(5));
    }
}
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "reverie-operations-process-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        Self(path)
    }
    fn initialized() -> Self {
        let tree = Self::new();
        let store = store(&tree.0, false);
        store.initialize(&scope()).unwrap();
        store.close().unwrap();
        tree
    }
    fn command(&self, mode: &str, employee: u64) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", "operation_child", "--nocapture"])
            .env("REVERIE_JOURNAL_TEST_ROOT", &self.0)
            .env("REVERIE_JOURNAL_TEST_MODE", mode)
            .env("REVERIE_JOURNAL_TEST_EMPLOYEE", employee.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit());
        command
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
#[allow(unsafe_code)]
fn restrictive_umask() {
    // SAFETY: only the dedicated --exact child uses this process-global option.
    unsafe {
        libc::umask(0o777);
    }
}
#[test]
fn operation_child() {
    let Some(root) = std::env::var_os("REVERIE_JOURNAL_TEST_ROOT") else {
        return;
    };
    let root = PathBuf::from(root);
    let mode = std::env::var("REVERIE_JOURNAL_TEST_MODE").unwrap();
    let employee: u64 = std::env::var("REVERIE_JOURNAL_TEST_EMPLOYEE")
        .unwrap()
        .parse()
        .unwrap();
    if mode == "umask" {
        restrictive_umask();
    }
    let store = store(&root, mode == "crash");
    if mode == "umask" {
        store.initialize(&scope()).unwrap();
    }
    if mode == "race" {
        fs::write(root.join(format!("ready-{employee}")), b"ready").unwrap();
        await_file(&root.join("start"));
    }
    let result = store.claim(
        &scope(),
        &id(employee + 20),
        &request(&id(employee)),
        &ClaimSelection::default(),
    );
    if mode == "race" {
        let outcome = match result {
            Ok(_) => "CLAIMED",
            Err(ref error) => error.code(),
        };
        fs::write(root.join(format!("result-{employee}")), outcome).unwrap();
    } else {
        assert!(result.is_ok());
    }
    store.close().unwrap();
}
#[test]
fn two_actual_processes_cannot_overbook_and_serial_recheck_discriminates_capacity() {
    let tree = Tree::initialized();
    let mut first = tree.command("race", 4).spawn().unwrap();
    let mut second = tree.command("race", 5).spawn().unwrap();
    await_file(&tree.0.join("ready-4"));
    await_file(&tree.0.join("ready-5"));
    fs::write(tree.0.join("start"), b"go").unwrap();
    assert!(first.wait().unwrap().success());
    assert!(second.wait().unwrap().success());
    let results = [
        (4, fs::read_to_string(tree.0.join("result-4")).unwrap()),
        (5, fs::read_to_string(tree.0.join("result-5")).unwrap()),
    ];
    assert_eq!(
        results
            .iter()
            .filter(|(_, result)| result == "CLAIMED")
            .count(),
        1
    );
    let loser = results
        .iter()
        .find(|(_, result)| result != "CLAIMED")
        .unwrap()
        .0;
    let store = store(&tree.0, false);
    assert_eq!(store.snapshot(&scope()).unwrap().operations().len(), 1);
    assert_eq!(
        store
            .claim(
                &scope(),
                &id(loser + 20),
                &request(&id(loser)),
                &ClaimSelection::default()
            )
            .err()
            .unwrap()
            .code(),
        "CAPACITY_EXHAUSTED"
    );
    store.close().unwrap();
}
#[test]
fn killed_after_durable_install_keeps_cold_claim_and_no_replayed_handle() {
    let tree = Tree::initialized();
    let mut child = tree.command("crash", 4).spawn().unwrap();
    await_file(&tree.0.join("installed"));
    child.kill().unwrap();
    assert_eq!(child.wait().unwrap().signal(), Some(libc::SIGKILL));
    let store = store(&tree.0, false);
    let view = store.lookup(&scope(), &id(24)).unwrap().unwrap();
    assert_eq!(view.state(), OperationState::RecoveryRequired);
    assert!(view.reservation_retained() && !view.retry_allowed());
    assert!(
        store
            .claim(
                &scope(),
                &id(24),
                &request(&id(4)),
                &ClaimSelection::default()
            )
            .unwrap()
            .1
            .is_none()
    );
    assert_eq!(
        store
            .claim(
                &scope(),
                &id(25),
                &request(&id(5)),
                &ClaimSelection::default()
            )
            .err()
            .unwrap()
            .code(),
        "CAPACITY_EXHAUSTED"
    );
    store.close().unwrap();
}
#[test]
fn restrictive_child_umask_still_produces_mode0600_journal_and_lock() {
    let tree = Tree::new();
    assert!(tree.command("umask", 4).status().unwrap().success());
    for name in ["operations.lock", "operations.json"] {
        let info = fs::metadata(tree.0.join(name)).unwrap();
        assert_eq!(info.mode() & 0o777, 0o600);
        assert_eq!(info.nlink(), 1);
    }
}
