//! Process fixtures live outside the library test executable: a fork here must
//! never inherit another unit-test thread's transient flock descriptor.
use reverie_core::ids::{ProfileEmployeeId, ProfileSessionId};
use reverie_core::profiles::{ProfileBinding, ProfilePutIntent};
use reverie_core::resources::{BudgetMode, CpuQuota, ResourcePolicy};
use reverie_core::revision::{Generation, ObservedProfileVersion, StoreRevision};
use reverie_store::profiles::ProfileStore;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{
    Mutex,
    atomic::{AtomicU64, Ordering},
};
use std::time::{Duration, Instant};

static NEXT: AtomicU64 = AtomicU64::new(0);
static FORK_CASES: Mutex<()> = Mutex::new(());
struct Tree {
    root: PathBuf,
}
impl Tree {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "reverie-profile-process-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        Self { root }
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}
fn new_intent() -> ProfilePutIntent {
    let employee = ProfileEmployeeId::parse("11111111-1111-4111-8111-111111111111").unwrap();
    let binding = ProfileBinding::try_new(
        employee.clone(),
        ProfileSessionId::parse("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").unwrap(),
        ProfileSessionId::parse("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb").unwrap(),
        Generation::try_new(1).unwrap(),
        Generation::try_new(2).unwrap(),
    )
    .unwrap();
    let resources = ResourcePolicy::try_new(
        BudgetMode::Admission,
        4096,
        512,
        CpuQuota::from_integer(0).unwrap(),
        49152,
        8192,
    )
    .unwrap();
    ProfilePutIntent::try_new(
        employee,
        resources,
        binding,
        StoreRevision::ZERO,
        ObservedProfileVersion::try_new(0).unwrap(),
        None,
    )
    .unwrap()
}
fn await_file(path: &Path) {
    let until = Instant::now() + Duration::from_secs(8);
    while !path.exists() {
        assert!(Instant::now() < until, "fixture timed out");
        std::thread::sleep(Duration::from_millis(5));
    }
}
#[allow(unsafe_code)]
fn child_umask(value: u32) -> u32 {
    // SAFETY: called only by the dedicated --exact child fixture. No other test
    // or application threads share that child's process-global umask.
    unsafe { libc::umask(value) }
}
#[test]
fn child_put() {
    let Some(root) = std::env::var_os("REVERIE_C1_CHILD_ROOT") else {
        return;
    };
    let root = PathBuf::from(root);
    let mode = std::env::var("REVERIE_C1_CHILD_MODE").unwrap();
    let store = ProfileStore::open(&root).unwrap();
    if mode == "umask" {
        let old = child_umask(0o200);
        let result = store.put(&new_intent());
        child_umask(old);
        assert!(result.is_ok());
        return;
    }
    fs::write(root.join(format!("ready-{}", std::process::id())), b"ready").unwrap();
    await_file(&root.join("go"));
    if store.put(&new_intent()).is_ok() {
        println!("C1_COMMITTED");
    } else {
        println!("C1_REFUSED");
    }
}
#[test]
fn two_processes_share_the_real_nonblocking_file_lock() {
    let _exclusive = FORK_CASES.lock().unwrap();
    let tree = Tree::new();
    let executable = std::env::current_exe().unwrap();
    let mut children = Vec::new();
    for _ in 0..2 {
        children.push(
            Command::new(&executable)
                .args(["--exact", "child_put", "--nocapture"])
                .env("REVERIE_C1_CHILD_ROOT", &tree.root)
                .env("REVERIE_C1_CHILD_MODE", "race")
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap(),
        );
    }
    for child in &children {
        await_file(&tree.root.join(format!("ready-{}", child.id())));
    }
    fs::write(tree.root.join("go"), b"go").unwrap();
    let mut committed = 0;
    for child in children {
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        committed += usize::from(String::from_utf8_lossy(&output.stdout).contains("C1_COMMITTED"));
    }
    assert_eq!(committed, 1);
    assert_eq!(
        ProfileStore::open(&tree.root)
            .unwrap()
            .snapshot()
            .unwrap()
            .revision()
            .get(),
        1
    );
}
#[test]
fn restrictive_umask_cannot_break_first_data_or_lock_publication() {
    let _exclusive = FORK_CASES.lock().unwrap();
    let tree = Tree::new();
    let output = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "child_put", "--nocapture"])
        .env("REVERIE_C1_CHILD_ROOT", &tree.root)
        .env("REVERIE_C1_CHILD_MODE", "umask")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    for name in ["profiles.json", "profiles.lock"] {
        assert_eq!(
            fs::metadata(tree.root.join(name))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    assert_eq!(
        ProfileStore::open(&tree.root)
            .unwrap()
            .snapshot()
            .unwrap()
            .revision()
            .get(),
        1
    );
}
