//! Source-test-only UID0 fixture. No host Docker socket or instance data is
//! mounted. Production Engine root-peer authentication remains unchanged.
//! Unix fixtures need no network namespace or loopback interface setup. Their
//! readiness address is held by an owned ephemeral refusal listener.
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
const MARKER: &str = "reverie-deployment-engine-socket-fixture-v1";

pub(crate) fn run(test: &str, scenario: fn()) {
    if std::env::var_os("NIX_REVERIE_ENGINE_SOCKET_CHILD").as_deref()
        == Some(std::ffi::OsStr::new("1"))
    {
        assert_eq!(fs::read_to_string("/fixture/marker").unwrap(), MARKER);
        assert_ne!(
            fs::read_link("/proc/self/ns/user").unwrap(),
            PathBuf::from(fs::read_to_string("/fixture/parent-namespace").unwrap())
        );
        assert_eq!(
            fs::read_link("/proc/self/ns/net").unwrap(),
            PathBuf::from(fs::read_to_string("/fixture/parent-network-namespace").unwrap()),
            "Unix-only fixture must not configure another network namespace"
        );
        assert_eq!(nix::unistd::geteuid().as_raw(), 0);
        assert_eq!(fs::metadata("/").unwrap().uid(), 0);
        scenario();
        return;
    }
    let directory = std::env::temp_dir().join(format!(
        "engine-pin-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&directory).unwrap();
    let result = child(&directory, test);
    fs::remove_dir_all(directory).unwrap();
    assert!(
        result.status.success(),
        "isolated Engine fixture failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(
        String::from_utf8_lossy(&result.stdout)
            .lines()
            .any(|line| line.starts_with("test result: ok. 1 passed; 0 failed;")),
        "isolated fixture did not execute exactly one selected test"
    );
}

use std::os::unix::fs::MetadataExt;
fn child(directory: &Path, test: &str) -> std::process::Output {
    for name in [
        "nix/store",
        "fixture",
        "run",
        "var",
        "tmp",
        "proc",
        "dev",
        "instances",
        "accounts",
        "other-writer",
        "sys/fs/cgroup",
        "virtual-cgroup",
        "virtual-cgroup-overlay",
        "hidden-run/cgroup",
        "home/agent",
        "reverie_workspace",
    ] {
        fs::create_dir_all(directory.join(name)).unwrap();
    }
    fs::write(directory.join("fixture/marker"), MARKER).unwrap();
    fs::write(directory.join("fixture/tests"), []).unwrap();
    fs::write(
        directory.join("fixture/cgroup-overlay"),
        "ordinary fixture file",
    )
    .unwrap();
    let data = directory.join("writer-data");
    let account = data.join("console/accounts/profile");
    fs::create_dir_all(&account).unwrap();
    let stale = data.join("disjoint-source");
    std::os::unix::fs::symlink(data.join("console"), &stale).unwrap();
    parent_namespaces(directory);
    let bwrap =
        std::env::var_os("NIX_REVERIE_TEST_DEPLOYMENT_BWRAP").unwrap_or_else(|| "bwrap".into());
    let mut command = Command::new(bwrap);
    command
        .args([
            "--unshare-user",
            "--unshare-pid",
            "--uid",
            "0",
            "--gid",
            "0",
            "--cap-drop",
            "ALL",
            "--die-with-parent",
            "--new-session",
            "--ro-bind",
        ])
        .arg(directory)
        .args([
            "/",
            "--ro-bind",
            "/nix/store",
            "/nix/store",
            "--tmpfs",
            "/run",
            "--tmpfs",
            "/var",
            "--tmpfs",
            "/tmp",
            "--tmpfs",
            "/instances",
            "--tmpfs",
            "/accounts",
            "--bind",
        ])
        .arg(&data)
        .args(["/tmp/deployment/data", "--bind"])
        .arg(&data)
        .args(["/instances/default", "--bind"])
        .arg(&data)
        .args(["/home/agent", "--bind"])
        .arg(&data)
        .args(["/reverie_workspace", "--bind"])
        .arg(account)
        .args(["/accounts/profile", "--bind"])
        .arg(stale)
        .arg("/other-writer");
    cgroup_mounts(&mut command, directory, test);
    command
        .args(["--proc", "/proc", "--dev", "/dev", "--ro-bind"])
        .arg(std::env::current_exe().unwrap())
        .args([
            "/fixture/tests",
            "--chdir",
            "/",
            "--setenv",
            "NIX_REVERIE_ENGINE_SOCKET_CHILD",
            "1",
            "/fixture/tests",
            "--include-ignored",
            "--exact",
        ])
        .arg(test)
        .arg("--nocapture")
        .output()
        .unwrap()
}

fn parent_namespaces(directory: &Path) {
    for (name, path) in [
        ("parent-namespace", "/proc/self/ns/user"),
        ("parent-network-namespace", "/proc/self/ns/net"),
    ] {
        fs::write(
            directory.join("fixture").join(name),
            fs::read_link(path).unwrap().to_str().unwrap(),
        )
        .unwrap();
    }
}

fn cgroup_mounts(command: &mut Command, directory: &Path, test: &str) {
    // Only the explicit native cases see real cgroup2, always read-only.
    if !test.starts_with("service::apply::live_accounts::tests::cgroup_") {
        return;
    }
    command
        .args([
            "--ro-bind",
            "/sys/fs/cgroup",
            "/sys/fs/cgroup",
            "--ro-bind",
            "/sys/fs/cgroup",
            "/virtual-cgroup",
            "--ro-bind",
            "/sys/fs/cgroup",
            "/virtual-cgroup-overlay",
            "--ro-bind",
        ])
        .arg(directory.join("fixture/cgroup-overlay"))
        .arg("/virtual-cgroup-overlay/cgroup.procs")
        .args([
            "--ro-bind",
            "/sys/fs/cgroup",
            "/hidden-run/cgroup",
            "--tmpfs",
            "/hidden-run",
        ]);
}
