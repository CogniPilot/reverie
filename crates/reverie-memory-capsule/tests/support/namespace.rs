#[path = "capture.rs"]
mod capture;
#[path = "guest.rs"]
mod guest;
use capture::checked;
use sha2::{Digest, Sha256};
use std::{
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const MARKER: &[u8] = b"owned-memory-capsule-qualification-v1";
pub(super) fn outer() {
    let capsule = PathBuf::from(
        std::env::var_os("REVERIE_TEST_MEMORY_GUEST_CAPSULE")
            .expect("explicit immutable candidate required"),
    )
    .canonicalize()
    .unwrap();
    assert!(capsule.starts_with("/nix/store"));
    assert_eq!(fs::metadata(&capsule).unwrap().uid(), 0);
    assert!(
        capsule
            .join("opt/reverie/memory/build-inputs.json")
            .is_file()
    );
    let root = std::env::temp_dir().join(format!(
        "memory-capsule-namespace-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&root).unwrap();
    let root = root.canonicalize().unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
    fs::write(root.join(".owned-capsule"), MARKER).unwrap();
    for name in [
        "opt/reverie",
        "home/agent",
        "fixture",
        "dev",
        "proc",
        "tmp",
        "etc",
        "run",
        "nix/store",
    ] {
        fs::create_dir_all(root.join(name)).unwrap();
    }
    checked(
        Command::new("cp")
            .args(["-R", "--reflink=auto"])
            .arg(capsule.join("opt/reverie/memory"))
            .arg(root.join("opt/reverie/memory")),
    );
    copy_loader_control(&capsule, &root);
    copy_legacy_fixtures(&root);
    for name in ["null", "urandom"] {
        fs::write(root.join("dev").join(name), []).unwrap();
    }
    let mut command = Command::new("unshare");
    command
        .args([
            "--user",
            "--map-auto",
            "--map-root-user",
            "--mount",
            "--propagation",
            "private",
            "--net",
            "--pid",
            "--fork",
            "--kill-child=SIGKILL",
        ])
        .arg(format!("--mount-proc={}", root.join("proc").display()))
        .arg(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "actual_guest_capsule_namespace",
            "--ignored",
            "--nocapture",
        ])
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap())
        .env("REVERIE_CAPSULE_TEST_INNER", &root);
    let output = capture::capture(&mut command, &[], Duration::from_secs(120));
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success(),
        "namespace root retained at {}: {}",
        root.display(),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        stdout.contains("test result: ok. 1 passed;")
            && stdout.contains("actual_guest_capsule_namespace"),
        "actual owning case must execute: {stdout}"
    );
    assert!(root.join("fixture/result.json").is_file());
    println!(
        "qualified synthetic namespace retained at {}",
        root.display()
    );
}

fn copy_legacy_fixtures(root: &Path) {
    for (name, bytes) in [
        (
            "legacy-memory.sqlite",
            include_bytes!("../fixtures/existing-memory-python.sqlite").as_slice(),
        ),
        (
            "legacy-profile.md",
            include_bytes!("../fixtures/existing-memory-python.profile.md").as_slice(),
        ),
        (
            "legacy-instance.json",
            include_bytes!("../fixtures/existing-memory-python.instance.json").as_slice(),
        ),
        (
            "legacy-info.json",
            include_bytes!("../fixtures/existing-memory-python.json").as_slice(),
        ),
    ] {
        let path = root.join("fixture").join(name);
        fs::write(&path, bytes).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o444)).unwrap();
    }
}

fn copy_loader_control(capsule: &Path, root: &Path) {
    // Test-only positive: immutable public input, never a runtime selector.
    let manifest: serde_json::Value = serde_json::from_slice(
        &fs::read(capsule.join("opt/reverie/memory/build-inputs.json")).unwrap(),
    )
    .unwrap();
    let artifact = manifest["elfArtifacts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|value| value["output"] == "lib/ld-linux-x86-64.so.2")
        .unwrap();
    let source = PathBuf::from(artifact["input"].as_str().unwrap())
        .canonicalize()
        .unwrap();
    assert!(source.starts_with("/nix/store"));
    let metadata = fs::metadata(&source).unwrap();
    assert_eq!(metadata.uid(), 0);
    assert_eq!(metadata.mode() & 0o222, 0);
    let bytes = fs::read(source).unwrap();
    assert_eq!(
        format!("{:x}", Sha256::digest(&bytes)),
        artifact["inputSha256"].as_str().unwrap()
    );
    let destination = root.join("fixture/original-loader");
    fs::write(&destination, bytes).unwrap();
    fs::set_permissions(destination, fs::Permissions::from_mode(0o555)).unwrap();
}

pub(super) fn inner() {
    let root = PathBuf::from(std::env::var_os("REVERIE_CAPSULE_TEST_INNER").unwrap())
        .canonicalize()
        .unwrap();
    assert_eq!(fs::read(root.join(".owned-capsule")).unwrap(), MARKER);
    let map = fs::read_to_string("/proc/self/uid_map").unwrap();
    let first: Vec<u32> = map
        .lines()
        .next()
        .unwrap()
        .split_whitespace()
        .map(|v| v.parse().unwrap())
        .collect();
    assert_eq!(first[0], 0);
    assert_ne!(
        first[1], 0,
        "never perform fixture mounts in the host root namespace"
    );
    assert_eq!(first[2], 1);
    assert_eq!(fs::metadata(&root).unwrap().uid(), 0);
    // This must succeed in the newly owned mount namespace before any bind.
    checked(Command::new("mount").args(["--make-rprivate", "/"]));
    for name in ["null", "urandom"] {
        checked(
            Command::new("mount")
                .arg("--bind")
                .arg(format!("/dev/{name}"))
                .arg(root.join("dev").join(name)),
        );
    }
    let prefix = root.join("opt/reverie/memory");
    checked(
        Command::new("mount")
            .arg("--bind")
            .arg(&prefix)
            .arg(&prefix),
    );
    checked(
        Command::new("mount")
            .args(["-o", "remount,bind,ro,nosuid,nodev"])
            .arg(&prefix),
    );
    checked(Command::new("ip").args(["link", "set", "lo", "up"]));
    fs::write(
        root.join("etc/passwd"),
        "root:x:0:0:root:/root:/none\nagent:x:1000:1000:synthetic:/home/agent:/none\n",
    )
    .unwrap();
    fs::write(root.join("etc/group"), "root:x:0:\nagent:x:1000:\n").unwrap();
    fs::write(
        root.join("etc/nsswitch.conf"),
        "hosts: files\npasswd: files\ngroup: files\n",
    )
    .unwrap();
    fs::write(root.join("etc/hosts"), "127.0.0.1 localhost\n").unwrap();
    checked(
        Command::new("chown")
            .args(["-R", "1000:1000"])
            .arg(root.join("home/agent")),
    );
    checked(
        Command::new("chown")
            .args(["-R", "1000:1000"])
            .arg(root.join("nix")),
    );
    fs::write(root.join("fixture/uid-map"), map).unwrap();
    // Safe standard-library adapter; no new first-party syscall/unsafe seam.
    std::os::unix::fs::chroot(&root).unwrap();
    std::env::set_current_dir(Path::new("/")).unwrap();
    guest::qualify();
}
