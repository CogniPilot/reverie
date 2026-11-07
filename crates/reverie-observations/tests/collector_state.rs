//! The command scenario of `tests/test_collector_state.py`. The `prepare`
//! scenarios are unit tests in `src/collector_state/tests.rs`, anchored at
//! their own fixture.
use reverie_contracts::collector_state::NOT_ADMINISTRATOR;
use std::fs;

#[test]
fn the_command_refuses_a_non_administrator_without_touching_the_path() {
    if nix::unistd::geteuid().is_root() {
        return;
    }
    let root = std::env::temp_dir().join(format!("collector-state-command-{}", std::process::id()));
    fs::create_dir_all(&root).unwrap();
    let state = root.join("collector");
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_reverie-collect-state"))
        .arg("--state-dir")
        .arg(&state)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        format!("reverie-collect-state: {NOT_ADMINISTRATOR}\n")
    );
    assert!(output.stderr.is_empty());
    assert!(!state.exists());
    let _ = fs::remove_dir_all(&root);
}
