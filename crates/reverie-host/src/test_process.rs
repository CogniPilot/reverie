//! Exact owning-test isolation for assertions requiring sole FD ownership.
//! CLOEXEC cannot prevent unrelated pre-exec forks from retaining an OFD.
pub(crate) fn isolate_case(name: &str) -> bool {
    const CASE: &str = "REVERIE_HOST_OWNING_TEST_CASE";
    if std::env::var_os(CASE).as_deref() == Some(std::ffi::OsStr::new(name)) {
        return false;
    }
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", name, "--test-threads=1"])
        .env(CASE, name)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "isolated {name}: {}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("test result: ok. 1 passed; 0 failed;"),
        "exact owning test must execute once"
    );
    true
}
