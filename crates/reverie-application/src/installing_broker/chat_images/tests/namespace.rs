//! Fixed maintained tool argv in an actual owned mount/PID/network namespace.
//! No installed company/container, host network policy or script is touched.
use super::*;
use sha2::{Digest, Sha256};
use std::os::unix::fs::DirBuilderExt;
const MARKER: &str = "REVERIE_M_OWNED_NAMESPACE";
pub(super) fn tool(name: &str) -> PathBuf {
    assert!(["unshare", "mount", "umount", "ip"].contains(&name));
    let path = std::env::split_paths(&std::env::var_os("PATH").unwrap())
        .map(|part| part.join(name))
        .find(|path| path.is_file())
        .expect("declared Nix tool in devShell");
    let path = fs::canonicalize(path).unwrap();
    assert!(
        path.starts_with("/nix/store"),
        "fixed maintained Nix tool: {}",
        path.display()
    );
    path
}
fn uid() -> u32 {
    let status = fs::read_to_string("/proc/self/status").unwrap();
    let values = status
        .lines()
        .find(|line| line.starts_with("Uid:"))
        .unwrap()
        .split_whitespace()
        .skip(1)
        .map(|v| v.parse::<u32>().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(values.len(), 4);
    assert!(values.iter().all(|v| *v == values[0]));
    assert!(values[0] > 0);
    values[0]
}
fn checked_command(tool: &Path, args: &[&str]) {
    let output = Command::new(tool).args(args).output().unwrap();
    assert!(
        output.status.success(),
        "owned namespace fixed argv failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}
pub(super) fn mount_tmp(source: &Path) {
    assert_eq!(std::process::id(), 1);
    let source = fs::canonicalize(source).unwrap();
    assert!(
        source.starts_with(fs::canonicalize(std::env::temp_dir()).unwrap())
            && !source.starts_with("/tmp")
    );
    checked_command(
        &tool("mount"),
        &["--bind", source.to_str().unwrap(), "/tmp"],
    );
}
pub(super) fn unmount_tmp() {
    checked_command(&tool("umount"), &["/tmp"]);
}
pub(super) fn isolate(case: &str) -> bool {
    let name = format!("installing_broker::chat_images::tests::{case}");
    if std::env::var(MARKER).ok().as_deref() == Some(&name) {
        assert_eq!(std::process::id(), 1);
        assert_eq!(
            uid().to_string(),
            std::env::var("REVERIE_M_NAMESPACE_UID").unwrap()
        );
        for (kind, var) in [
            ("net", "REVERIE_M_PARENT_NET"),
            ("mnt", "REVERIE_M_PARENT_MNT"),
        ] {
            assert_ne!(
                fs::read_link(format!("/proc/self/ns/{kind}"))
                    .unwrap()
                    .as_os_str(),
                std::env::var_os(var).unwrap()
            );
        }
        let status = fs::read_to_string("/proc/self/status").unwrap();
        let caps = status
            .lines()
            .find_map(|line| line.strip_prefix("CapEff:"))
            .unwrap()
            .trim();
        assert_ne!(
            u64::from_str_radix(caps, 16).unwrap() & (1 << 21),
            0,
            "own namespace mount capability"
        );
        checked_command(&tool("ip"), &["link", "set", "dev", "lo", "up"]);
        return false;
    }
    let current_uid = uid();
    let home = fs::canonicalize(std::env::var_os("HOME").unwrap()).unwrap();
    assert!(!home.starts_with("/tmp") && fs::metadata(&home).unwrap().uid() == current_uid);
    let nonce = reverie_store::worker_storage::instruction_temporary_name().unwrap();
    let root = home.join(format!(".mi-{}", &nonce[nonce.len() - 8..]));
    fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
    let original = fs::metadata(&root).unwrap();
    let source = std::env::current_exe().unwrap();
    let executable = root.join("namespace-tests.elf");
    fs::copy(&source, &executable).unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(digest(&source), digest(&executable));
    let output = Command::new(tool("unshare"))
        .args([
            "--user",
            "--map-current-user",
            "--keep-caps",
            "--mount",
            "--pid",
            "--net",
            "--fork",
            "--mount-proc",
            "--propagation",
            "private",
            "--kill-child=TERM",
        ])
        .arg(executable)
        .args(["--exact", &name, "--test-threads=1", "--nocapture"])
        .env(MARKER, &name)
        .env("REVERIE_M_NAMESPACE_UID", current_uid.to_string())
        .env(
            "REVERIE_M_PARENT_NET",
            fs::read_link("/proc/self/ns/net").unwrap(),
        )
        .env(
            "REVERIE_M_PARENT_MNT",
            fs::read_link("/proc/self/ns/mnt").unwrap(),
        )
        .env("TMPDIR", &root)
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "own M namespace preserved at {}\n{stdout}\n{stderr}",
        root.display()
    );
    assert!(
        stdout.contains("test result: ok. 1 passed; 0 failed;")
            && stdout.contains(&format!("test {name} ... ok")),
        "exact owned selector executed"
    );
    let named = fs::metadata(&root).unwrap();
    assert_eq!(
        (named.dev(), named.ino(), named.uid()),
        (original.dev(), original.ino(), original.uid())
    );
    // Exact namespace supervisor/child are terminal; its PID namespace members
    // cannot survive PID1. Only this unique successful synthetic root is removed.
    fs::remove_dir_all(root).unwrap();
    true
}
fn digest(path: &Path) -> [u8; 32] {
    let mut file = fs::File::open(path).unwrap();
    let mut hash = Sha256::new();
    let mut bytes = [0; 65536];
    loop {
        let count = file.read(&mut bytes).unwrap();
        if count == 0 {
            return hash.finalize().into();
        }
        hash.update(&bytes[..count]);
    }
}
