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
}

use std::os::unix::fs::MetadataExt;
fn prepare(directory: &Path) -> (PathBuf, PathBuf, PathBuf) {
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
    ] {
        fs::create_dir_all(directory.join(name)).unwrap();
    }
    fs::write(directory.join("fixture/marker"), MARKER).unwrap();
    fs::write(directory.join("fixture/tests"), []).unwrap();
    let data = directory.join("writer-data");
    let account = data.join("console/accounts/profile");
    fs::create_dir_all(&account).unwrap();
    let stale = data.join("disjoint-source");
    std::os::unix::fs::symlink(data.join("console"), &stale).unwrap();
    fs::write(
        directory.join("fixture/parent-namespace"),
        fs::read_link("/proc/self/ns/user")
            .unwrap()
            .to_str()
            .unwrap(),
    )
    .unwrap();
    fs::write(
        directory.join("fixture/parent-network-namespace"),
        fs::read_link("/proc/self/ns/net")
            .unwrap()
            .to_str()
            .unwrap(),
    )
    .unwrap();
    (data, account, stale)
}
fn child(directory: &Path, test: &str) -> std::process::Output {
    let (data, account, stale) = prepare(directory);
    let bwrap =
        std::env::var_os("NIX_REVERIE_TEST_DEPLOYMENT_BWRAP").unwrap_or_else(|| "bwrap".into());
    Command::new(bwrap)
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
        .arg(account)
        .args(["/accounts/profile", "--bind"])
        .arg(stale)
        .args([
            "/other-writer",
            "--proc",
            "/proc",
            "--dev",
            "/dev",
            "--ro-bind",
        ])
        .arg(std::env::current_exe().unwrap())
        .args([
            "/fixture/tests",
            "--chdir",
            "/",
            "--setenv",
            "NIX_REVERIE_ENGINE_SOCKET_CHILD",
            "1",
            "/fixture/tests",
            "--exact",
        ])
        .arg(test)
        .arg("--nocapture")
        .output()
        .unwrap()
}
