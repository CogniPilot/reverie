//! Keep real lock-close/reacquire oracles in their exact owning process. An
//! unrelated test's pre-exec child can retain a CLOEXEC flock OFD temporarily.
//! This repairs only test ownership; it proves no production global release.
use std::process::Command;
use std::{
    path::{Path, PathBuf},
    sync::{
        OnceLock,
        mpsc::{Receiver, SyncSender, sync_channel},
    },
    time::Duration,
};
/// Test-only stage synchronization, after a real production owner has captured
/// its value. It cannot substitute a result, context or permission.
pub(crate) struct PausePoint<T> {
    reached: SyncSender<T>,
    release: Receiver<()>,
}
pub(crate) fn pause_point<T>() -> (PausePoint<T>, Receiver<T>, SyncSender<()>) {
    let (reached, observed) = sync_channel(1);
    let (resume, release) = sync_channel(1);
    (PausePoint { reached, release }, observed, resume)
}
impl<T> PausePoint<T> {
    pub(crate) fn wait(self, captured: T) {
        assert!(
            self.reached.send(captured).is_ok(),
            "owning stage receiver remains present"
        );
        self.release
            .recv_timeout(Duration::from_secs(15))
            .expect("bounded owning setup releases actual stage");
    }
}
pub(crate) fn engine_program() -> &'static Path {
    static PROGRAM: OnceLock<PathBuf> = OnceLock::new();
    PROGRAM.get_or_init(|| {
        let root = fixture_directory("reverie-application-engine-program");
        let source = root.join("child.rs");
        std::fs::write(
            &source,
            include_str!("../../reverie-host/tests/support/engine_metadata_child.rs"),
        )
        .unwrap();
        let binary = root.join("storage-writer");
        assert!(
            Command::new("rustc")
                .arg("--edition=2024")
                .arg(&source)
                .arg("-o")
                .arg(&binary)
                .status()
                .unwrap()
                .success()
        );
        binary
    })
}
/// Atomically allocate a fresh private test directory. A recycled PID must
/// never adopt, delete or overwrite an earlier fixture's files.
pub(crate) fn fixture_directory(label: &str) -> PathBuf {
    fixture_directory_in(&std::env::temp_dir(), label)
}
fn fixture_directory_in(parent: &Path, label: &str) -> PathBuf {
    assert!(
        !label.is_empty()
            && label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    );
    let template = parent.join(format!("{label}-{}-XXXXXX", std::process::id()));
    nix::unistd::mkdtemp(&template).expect("fresh private owning fixture directory")
}
pub(crate) fn isolate_case(name: &str) -> bool {
    const KEY: &str = "REVERIE_APPLICATION_OWNING_CASE";
    if std::env::var(KEY).as_deref() == Ok(name) {
        return false;
    }
    let output = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", name, "--nocapture", "--test-threads=1"])
        .env(KEY, name)
        .output()
        .unwrap();
    assert!(
        output.status.success()
            && String::from_utf8_lossy(&output.stdout)
                .contains("test result: ok. 1 passed; 0 failed;"),
        "owning selector {name} must execute exactly one test; status={:?}\nstdout:\n{}\nstderr:\n{}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    true
}
macro_rules! owning_case {
    ($name:ident) => {{
        let (_, module) = module_path!()
            .split_once("::")
            .expect("owning case lives inside a test module");
        if $crate::test_process::isolate_case(&format!("{module}::{}", stringify!($name))) {
            return;
        }
    }};
}
pub(crate) use owning_case;
#[test]
fn missing_exact_selector_cannot_qualify_as_a_passed_owning_case() {
    assert!(std::panic::catch_unwind(|| isolate_case("__missing_reverie_owning_case__")).is_err());
}
#[test]
fn fresh_fixture_directories_preserve_existing_pid_named_files() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let parent = fixture_directory("directory-collision-control");
    let label = "reverie-application-engine-program";
    let stale = parent.join(format!("{label}-{}", std::process::id()));
    std::fs::create_dir(&stale).unwrap();
    std::fs::write(stale.join("retained"), b"existing fixture evidence").unwrap();
    let before = std::fs::metadata(&stale).unwrap();
    let first = fixture_directory_in(&parent, label);
    let second = fixture_directory_in(&parent, label);
    assert!(first != second && first != stale && second != stale);
    for path in [&first, &second] {
        assert_eq!(
            std::fs::metadata(path).unwrap().permissions().mode() & 0o7777,
            0o700
        );
    }
    let after = std::fs::metadata(&stale).unwrap();
    assert_eq!((before.dev(), before.ino()), (after.dev(), after.ino()));
    assert_eq!(
        std::fs::read(stale.join("retained")).unwrap(),
        b"existing fixture evidence"
    );
    std::fs::remove_dir_all(parent).unwrap();
}
