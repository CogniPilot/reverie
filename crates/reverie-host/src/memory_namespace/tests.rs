use super::*;
use std::process::Command;

#[test]
fn actual_namespace_is_held_checked_and_explicitly_closed() {
    let mut held = MemoryNamespace::capture_current().unwrap();
    assert_eq!(held.entries.len(), 5);
    assert!(held.entries.iter().all(|entry| entry.file.is_some()));
    held.assert_current().unwrap();
    held.close().unwrap();
    assert!(held.entries.iter().all(|entry| entry.file.is_none()));
    assert!(matches!(held.assert_current(), Err(NamespaceError::Closed)));
    held.close().unwrap();
}
#[test]
fn a_checked_close_failure_releases_every_descriptor_and_remains_fenced() {
    let mut held = MemoryNamespace::capture_current().unwrap();
    native::test_faults::set(None, true);
    assert!(matches!(held.close(), Err(NamespaceError::Native(_))));
    assert!(held.entries.iter().all(|entry| entry.file.is_none()));
    assert!(matches!(
        held.close(),
        Err(NamespaceError::CloseUnconfirmed)
    ));
    assert!(matches!(
        held.assert_current(),
        Err(NamespaceError::CloseUnconfirmed)
    ));
}
#[test]
fn actual_child_cwd_drift_refuses_the_installed_namespace() {
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "memory_namespace::tests::cwd_child",
            "--nocapture",
        ])
        .env("OWNED_MEMORY_NAMESPACE_CWD", "1")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
#[test]
fn cwd_child() {
    if std::env::var_os("OWNED_MEMORY_NAMESPACE_CWD").is_none() {
        return;
    }
    let mut held = MemoryNamespace::capture_current().unwrap();
    let prior = std::env::current_dir().unwrap();
    std::env::set_current_dir("/").unwrap();
    assert!(matches!(
        held.assert_current(),
        Err(NamespaceError::Changed)
    ));
    std::env::set_current_dir(prior).unwrap();
    held.assert_current().unwrap();
    held.close().unwrap();
}
