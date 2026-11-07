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

/// Cold's fixed owning test namespace. It retains the positive service UID;
/// the unrelated required memory root_case continues to exercise actual UID0.
pub(crate) fn isolate_cold_namespace(name: &str) -> bool {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt};
    const MARKER: &str = "REVERIE_COLD_NAMESPACE_CASE";
    assert!(
        name.starts_with("worker_storage::tests::owner::cold_admission::")
            || name.starts_with("worker_laptop::tests::cold_prepare::")
            || name.starts_with("worker_storage::cold_tmp::retained::references::tests::actual_")
    );
    if std::env::var_os(MARKER).as_deref() == Some(std::ffi::OsStr::new(name)) {
        assert_eq!(std::process::id(), 1, "actual owned PID namespace");
        assert!(crate::native::uid() > 0, "actual positive worker UID");
        assert_eq!(
            crate::native::uid().to_string(),
            std::env::var("REVERIE_COLD_NAMESPACE_UID").unwrap()
        );
        return false;
    }
    let nonce = reverie_store::worker_storage::instruction_temporary_name().unwrap();
    let root = std::env::temp_dir().join(format!("cn-{}", &nonce[nonce.len() - 8..]));
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&root)
        .unwrap();
    let original = std::fs::symlink_metadata(&root).unwrap();
    let output = std::process::Command::new("unshare")
        .args([
            "--user",
            "--map-current-user",
            "--mount",
            "--pid",
            "--fork",
            "--mount-proc",
            "--propagation",
            "private",
            "--kill-child=TERM",
        ])
        .arg(std::env::current_exe().unwrap())
        .args(["--exact", name, "--test-threads=1", "--nocapture"])
        .env(MARKER, name)
        .env(
            "REVERIE_COLD_NAMESPACE_UID",
            crate::native::uid().to_string(),
        )
        .env("TMPDIR", &root)
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "owned namespace preserved at {}\n{stdout}\n{stderr}",
        root.display()
    );
    assert!(
        stdout.contains("test result: ok. 1 passed; 0 failed;")
            && stdout.contains(&format!("test {name} ... ok")),
        "exact owning selector; fixture preserved at {}\n{stdout}\n{stderr}",
        root.display()
    );
    let named = std::fs::symlink_metadata(&root).unwrap();
    assert!(
        named.is_dir()
            && (named.dev(), named.ino(), named.uid())
                == (original.dev(), original.ino(), original.uid())
    );
    // The exact namespace child and every process in its PID namespace have
    // terminated; only this uniquely created test root is removed.
    std::fs::remove_dir_all(root).unwrap();
    true
}
