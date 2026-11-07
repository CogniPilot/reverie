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
    let executable = if retained_mount_case(name) {
        // The fixed test overmounts /tmp. Its executable must not itself be a
        // real reference beneath that mount, regardless of Cargo's target path.
        copy_namespace_executable(&root)
    } else {
        std::env::current_exe().unwrap()
    };
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
        .arg(&executable)
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
/// Copy only the actual current test ELF into the uniquely owned fixture.
/// No caller-selected executable or production/reference-reader change.
fn copy_namespace_executable(root: &std::path::Path) -> std::path::PathBuf {
    use std::{
        fs::{File, OpenOptions},
        io::{Seek, SeekFrom},
        os::unix::fs::{MetadataExt, OpenOptionsExt},
    };
    let mut source = File::open(std::env::current_exe().unwrap()).unwrap();
    let original = source.metadata().unwrap();
    assert!(original.is_file());
    let path = root.join("namespace-tests.elf");
    let mut output = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o700)
        .open(&path)
        .unwrap();
    assert_eq!(
        std::io::copy(&mut source, &mut output).unwrap(),
        original.len()
    );
    output.sync_all().unwrap();
    source.seek(SeekFrom::Start(0)).unwrap();
    output.seek(SeekFrom::Start(0)).unwrap();
    assert_eq!(
        executable_digest(&mut source),
        executable_digest(&mut output)
    );
    let current = source.metadata().unwrap();
    assert_eq!(
        (
            current.dev(),
            current.ino(),
            current.len(),
            current.mtime(),
            current.mtime_nsec(),
            current.ctime(),
            current.ctime_nsec()
        ),
        (
            original.dev(),
            original.ino(),
            original.len(),
            original.mtime(),
            original.mtime_nsec(),
            original.ctime(),
            original.ctime_nsec()
        )
    );
    crate::native::close(source).unwrap();
    crate::native::close(output).unwrap();
    path
}
fn executable_digest(file: &mut std::fs::File) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut digest = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).unwrap();
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    digest.finalize().into()
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
