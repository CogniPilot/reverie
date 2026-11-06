use super::*;
use std::{
    fs,
    io::{Read, Write},
    process::{Command, Output, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
const ENTRY: &str = "memory_lifecycle::tests::lifecycle_child";
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "memory-lifecycle-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::create_dir(path.join("config")).unwrap();
        fs::write(
            path.join("config/instance.json"),
            r#"{"id":"synthetic","agent_name":"Agent","owner_name":"Owner","data_dir":"../state","persona":"Selected persona"}"#,
        )
        .unwrap();
        Self(path.canonicalize().unwrap())
    }
    fn command(&self, case: &str) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", ENTRY, "--nocapture"])
            .env("OWNED_MEMORY_LIFECYCLE", case)
            .env(
                "REVERIE_INSTANCE_CONFIG",
                self.0.join("config/instance.json"),
            );
        command
    }
    fn run(&self, case: &str) {
        successful(self.command(case).output().unwrap());
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn successful(output: Output) {
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
#[test]
fn missing_read_has_no_bootstrap_effect_and_shared_readers_fence_startup() {
    let tree = Tree::new();
    tree.run("missing");
    assert!(!tree.0.join("state").exists());
    tree.run("locks");
}
#[test]
fn a_real_other_process_cannot_start_or_read_through_the_startup_lock() {
    let tree = Tree::new();
    let mut child = tree
        .command("hold")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !tree.0.join("state/held").exists() {
        assert!(
            Instant::now() < deadline,
            "child did not acquire actual lock"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    tree.run("busy");
    child.stdin.take().unwrap().write_all(b"x").unwrap();
    successful(child.wait_with_output().unwrap());
    tree.run("read");
}
#[test]
fn a_foreign_control_replacement_survives_refusal_and_closure_stays_fenced() {
    Tree::new().run("replace");
}
#[test]
fn lifecycle_child() {
    let Ok(case) = std::env::var("OWNED_MEMORY_LIFECYCLE") else {
        return;
    };
    let configuration = MemoryConfiguration::capture().unwrap();
    let scope = MemoryScope::Private;
    if case == "missing" {
        assert!(matches!(
            MemoryOperationLock::recall(&configuration, &scope),
            Err(LifecycleError::NotInitialized)
        ));
        return;
    }
    configuration.ensure_directories().unwrap();
    match case.as_str() {
        "locks" => same_process_locks(&configuration),
        "hold" => {
            let mut held = MemoryOperationLock::startup(&configuration, &scope).unwrap();
            fs::write(
                scope_directory(&configuration, &scope)
                    .unwrap()
                    .join("held"),
                b"test-sync-only",
            )
            .unwrap();
            let mut byte = [0];
            std::io::stdin().read_exact(&mut byte).unwrap();
            held.close().unwrap();
        }
        "busy" => {
            assert!(matches!(
                MemoryOperationLock::recall(&configuration, &scope),
                Err(LifecycleError::Busy)
            ));
            assert!(matches!(
                MemoryOperationLock::startup(&configuration, &scope),
                Err(LifecycleError::Busy)
            ));
        }
        "read" => {
            let mut held = MemoryOperationLock::recall(&configuration, &scope).unwrap();
            held.assert_current().unwrap();
            held.close().unwrap();
        }
        "replace" => replacement(&configuration),
        _ => panic!("unknown owned case"),
    }
}
fn same_process_locks(configuration: &MemoryConfiguration) {
    let scope = MemoryScope::Private;
    let mut startup = MemoryOperationLock::startup(configuration, &scope).unwrap();
    assert!(matches!(
        MemoryOperationLock::recall(configuration, &scope),
        Err(LifecycleError::Busy)
    ));
    startup.close().unwrap();
    let mut first = MemoryOperationLock::recall(configuration, &scope).unwrap();
    let mut second = MemoryOperationLock::recall(configuration, &scope).unwrap();
    assert!(matches!(
        MemoryOperationLock::startup(configuration, &scope),
        Err(LifecycleError::Busy)
    ));
    first.close().unwrap();
    assert!(matches!(
        MemoryOperationLock::startup(configuration, &scope),
        Err(LifecycleError::Busy)
    ));
    second.close().unwrap();
    MemoryOperationLock::startup(configuration, &scope)
        .unwrap()
        .close()
        .unwrap();
}
fn replacement(configuration: &MemoryConfiguration) {
    use std::os::unix::fs::PermissionsExt;
    let mut held = MemoryOperationLock::startup(configuration, &MemoryScope::Private).unwrap();
    let directory = scope_directory(configuration, &MemoryScope::Private).unwrap();
    let path = directory.join(".memory-lifecycle-v1.lock");
    fs::rename(&path, directory.join("retired-owned-lock")).unwrap();
    fs::write(&path, b"").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(matches!(
        held.assert_current(),
        Err(LifecycleError::Changed)
    ));
    assert!(matches!(held.close(), Err(LifecycleError::Changed)));
    assert!(matches!(
        held.close(),
        Err(LifecycleError::CloseUnconfirmed)
    ));
    assert!(path.is_file());
    assert_eq!(fs::read(path).unwrap(), b"");
}
