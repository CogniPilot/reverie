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
        if retained_mount_case(name) {
            assert_ne!(
                std::fs::read_link("/proc/self/ns/net").unwrap().as_os_str(),
                std::env::var_os("REVERIE_COLD_PARENT_NETWORK").unwrap(),
                "fixed finish control must not reinterpret host Unix paths beneath its own /tmp mount"
            );
            let status = std::fs::read_to_string("/proc/self/status").unwrap();
            let caps = status
                .lines()
                .find_map(|line| line.strip_prefix("CapEff:"))
                .unwrap()
                .trim();
            assert_ne!(
                u64::from_str_radix(caps, 16).unwrap() & (1 << 21),
                0,
                "actual private-user-namespace CAP_SYS_ADMIN for fixed bind control"
            );
        }
        return false;
    }
    let nonce = reverie_store::worker_storage::instruction_temporary_name().unwrap();
    let root = cold_fixture_root(name, &nonce);
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&root)
        .unwrap();
    let original = std::fs::symlink_metadata(&root).unwrap();
    let mut command = std::process::Command::new("unshare");
    command.args([
        "--user",
        "--map-current-user",
        "--mount",
        "--pid",
        "--fork",
        "--mount-proc",
        "--propagation",
        "private",
        "--kill-child=TERM",
    ]);
    // util-linux explicitly carries this new namespace's granted capabilities
    // across exec. Only fixed retained-finish tests require actual bind mounts;
    // ordinary same-UID permission/UNKNOWN and required root cases are unchanged.
    if retained_mount_case(name) {
        command.args(["--keep-caps", "--net"]);
        command.env(
            "REVERIE_COLD_PARENT_NETWORK",
            std::fs::read_link("/proc/self/ns/net").unwrap(),
        );
    }
    let output = command
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
fn retained_mount_case(name: &str) -> bool {
    name.starts_with("worker_laptop::tests::cold_prepare::retained::finish::")
}
fn cold_fixture_root(name: &str, nonce: &str) -> std::path::PathBuf {
    let leaf = format!("cn-{}", &nonce[nonce.len() - 8..]);
    if !retained_mount_case(name) {
        return std::env::temp_dir().join(leaf);
    }
    // xtask intentionally supplies /tmp; fixed finish cases overmount it.
    // Reuse current-account NSS facts, never an env/program/grant selector.
    let home = crate::native::home_directory(None).unwrap();
    let home = std::fs::canonicalize(crate::native::python_path(&home).unwrap()).unwrap();
    assert!(
        !home.starts_with("/tmp"),
        "fixed mounted-/tmp controls require a writable account home outside /tmp"
    );
    home.join(format!(".{leaf}"))
}
