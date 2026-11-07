//! Actual public loader bytes, an owned mount namespace and a missing object.
//! No injected library executes and no image/caller authority is established.
#![cfg(target_os = "linux")]
#![forbid(unsafe_code)]
#[path = "support/capture.rs"]
mod capture;
use std::{
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
const NODE: &str = "/nix/store/4z5m8x8i2qvln9s6wm5z0pdccbvsfih8-nodejs-slim-22.23.3/bin/node";
const LOADER: &str =
    "/nix/store/fsd4vbp9zjd9iaicq2fb9lpc1h5j973y-glibc-2.42-100/lib/ld-linux-x86-64.so.2";
const OLD: &[u8] = b"/etc/ld-nix.so.preload";
const ABSENT: &[u8] = b"/opt/rvmem/preload.off";
const MISSING: &str = "/__reverie_owned_missing_preload__.so";
const CASE: &str = "owned_loader_system_preload_positive_and_absent_path_negative";

#[test]
#[ignore = "explicit public-artifact loader qualification in an owned user/mount namespace"]
fn owned_loader_system_preload_positive_and_absent_path_negative() {
    if std::env::var_os("REVERIE_LOADER_TEST_INNER").is_some() {
        inner();
    } else {
        outer();
    }
}
fn outer() {
    assert_eq!(OLD.len(), ABSENT.len());
    assert_eq!(fs::metadata(LOADER).unwrap().uid(), 0);
    assert_eq!(fs::metadata(NODE).unwrap().uid(), 0);
    let root = std::env::temp_dir().join(format!(
        "reverie-loader-hook-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    let root = root.canonicalize().unwrap();
    fs::write(root.join("owned-marker"), b"loader-hook-qualification-v1").unwrap();
    fs::create_dir(root.join("etc")).unwrap();
    fs::write(root.join("etc/ld-nix.so.preload"), format!("{MISSING}\n")).unwrap();
    let mut bytes = fs::read(LOADER).unwrap();
    let mut replacements = 0;
    for at in 0..=bytes.len() - OLD.len() {
        if bytes[at..].starts_with(OLD) {
            bytes[at..at + OLD.len()].copy_from_slice(ABSENT);
            replacements += 1;
        }
    }
    assert_eq!(replacements, 1, "bind the actual qualified loader input");
    fs::write(root.join("loader-absent"), &bytes).unwrap();
    fs::set_permissions(
        root.join("loader-absent"),
        fs::Permissions::from_mode(0o555),
    )
    .unwrap();
    let output = capture::capture(
        Command::new("/run/current-system/sw/bin/unshare")
            .args([
                "--user",
                "--map-root-user",
                "--mount",
                "--propagation",
                "private",
                "--pid",
                "--fork",
                "--kill-child=SIGKILL",
            ])
            .arg(std::env::current_exe().unwrap())
            .args(["--exact", CASE, "--ignored", "--nocapture"])
            .env_clear()
            .env("REVERIE_LOADER_TEST_INNER", &root),
        &[],
        Duration::from_secs(30),
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains(CASE) && stdout.contains("test result: ok. 1 passed;"));
    assert!(root.join("result.json").is_file());
    println!("actual loader qualification retained at {}", root.display());
}
fn inner() {
    let root = PathBuf::from(std::env::var_os("REVERIE_LOADER_TEST_INNER").unwrap());
    assert_eq!(
        fs::read(root.join("owned-marker")).unwrap(),
        b"loader-hook-qualification-v1"
    );
    let map = fs::read_to_string("/proc/self/uid_map").unwrap();
    let first = map
        .lines()
        .next()
        .unwrap()
        .split_whitespace()
        .map(|v| v.parse::<u32>().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(first[0], 0);
    assert_ne!(first[1], 0, "never mount over the host namespace");
    assert_eq!(first[2], 1);
    assert!(!Path::new(MISSING).exists());
    assert!(!Path::new("/opt/rvmem").exists());
    // Make propagation private before the sole bind of this synthetic /etc.
    capture::checked(
        Command::new("/run/current-system/sw/bin/mount").args(["--make-rprivate", "/"]),
    );
    capture::checked(
        Command::new("/run/current-system/sw/bin/mount")
            .arg("--bind")
            .arg(root.join("etc"))
            .arg("/etc"),
    );
    let baseline = capture::capture(
        Command::new(LOADER).args(["--list", NODE]).env_clear(),
        &[],
        Duration::from_secs(10),
    );
    assert!(baseline.status.success());
    let warning = String::from_utf8_lossy(&baseline.stderr);
    assert!(
        warning.contains(MISSING) && warning.contains("/etc/ld-nix.so.preload"),
        "actual preload hook must run: {warning}"
    );
    let corrected = capture::capture(
        Command::new(root.join("loader-absent"))
            .args(["--list", NODE])
            .env_clear(),
        &[],
        Duration::from_secs(10),
    );
    assert!(
        corrected.status.success(),
        "{}",
        String::from_utf8_lossy(&corrected.stderr)
    );
    assert!(corrected.stderr.is_empty());
    assert_eq!(
        fs::read_to_string("/etc/ld-nix.so.preload").unwrap(),
        format!("{MISSING}\n")
    );
    fs::write(root.join("positive-stderr.txt"), baseline.stderr).unwrap();
    fs::write(root.join("negative-stderr.txt"), corrected.stderr).unwrap();
    fs::write(root.join("result.json"), serde_json::to_vec_pretty(&serde_json::json!({
        "scope":"public loader --list only; no injected object, image, context, grant or program main",
        "uidMap":map,"originalLoader":LOADER,"node":NODE,
        "preloadHookPositive":true,"equalLengthAbsentPathNegative":true,
    })).unwrap()).unwrap();
}
