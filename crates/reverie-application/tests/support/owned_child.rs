//! A successful test process is evidence only when the exact owned case ran.
use std::process::Output;

pub(super) fn successful(output: Output, entry: &str) {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success()
            && stdout.contains("test result: ok. 1 passed; 0 failed;")
            && stdout.contains(&format!("test {entry} ...")),
        "owned case {entry} did not run exactly once: {}\n{stdout}\n{stderr}",
        output.status,
    );
}

#[test]
fn successful_zero_case_selection_is_not_qualification() {
    const ABSENT: &str = "__reverie_owned_case_does_not_exist__";
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", ABSENT])
        .env_clear()
        .output()
        .unwrap();
    // This actual harness result satisfied the previous status-only check.
    assert!(output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout).contains("0 passed;"));
    assert!(std::panic::catch_unwind(|| successful(output, ABSENT)).is_err());
}
