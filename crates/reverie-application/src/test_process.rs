//! Keep real lock-close/reacquire oracles in their exact owning process. An
//! unrelated test's pre-exec child can retain a CLOEXEC flock OFD temporarily.
//! This repairs only test ownership; it proves no production global release.
use std::process::Command;
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
