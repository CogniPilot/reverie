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
        let root = std::env::temp_dir().join(format!(
            "reverie-application-engine-program-{}",
            std::process::id()
        ));
        std::fs::create_dir(&root).unwrap();
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
