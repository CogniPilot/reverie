use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "reverie-policy-producer-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        fs::write(
            path.join("base.json"),
            br#"{"defaultAction":"SCMP_ACT_ERRNO","syscalls":[]}"#,
        )
        .unwrap();
        Self(path)
    }
    fn command(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_reverie-policy-artifacts"));
        command
            .arg("--base-profile")
            .arg(self.0.join("base.json"))
            .arg("--output-directory")
            .arg(&self.0)
            .args(["--system", "x86_64-linux"]);
        command
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
#[test]
fn actual_cli_writes_exact_existing_schema_and_never_overwrites_a_leaf() {
    let tree = Tree::new();
    assert!(tree.command().status().unwrap().success());
    let profile = fs::read(tree.0.join("task-perf-seccomp.json")).unwrap();
    let manifest = fs::read(tree.0.join("worker-perf-profile.json")).unwrap();
    assert_eq!(profile.last(), Some(&b'\n'));
    assert_eq!(manifest.last(), Some(&b'\n'));
    assert!(!tree.command().status().unwrap().success());
    assert_eq!(
        fs::read(tree.0.join("task-perf-seccomp.json")).unwrap(),
        profile
    );
    assert_eq!(
        fs::read(tree.0.join("worker-perf-profile.json")).unwrap(),
        manifest
    );
}
#[test]
fn help_invalid_arguments_and_invalid_profile_do_not_create_outputs() {
    let tree = Tree::new();
    for flag in ["--help", "--version"] {
        let output = Command::new(env!("CARGO_BIN_EXE_reverie-policy-artifacts"))
            .arg(flag)
            .current_dir(&tree.0)
            .output()
            .unwrap();
        assert!(output.status.success());
    }
    assert_eq!(
        tree.command().arg("--unknown").status().unwrap().code(),
        Some(2)
    );
    fs::write(tree.0.join("base.json"), b"{}").unwrap();
    assert!(!tree.command().status().unwrap().success());
    assert!(!tree.0.join("task-perf-seccomp.json").exists());
    assert!(!tree.0.join("worker-perf-profile.json").exists());
}

#[test]
fn read_only_verification_refuses_mixed_modes_and_bad_manifest_without_writing() {
    let tree = Tree::new();
    let manifest = tree.0.join("worker-perf-profile.json");
    let original = b"{\"version\":1,\"purpose\":\"foreign\"}";
    fs::write(&manifest, original).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_reverie-policy-artifacts"))
        .arg("--verify-manifest")
        .arg(&manifest)
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert_eq!(fs::read(&manifest).unwrap(), original);
    assert!(!tree.0.join("task-perf-seccomp.json").exists());
    assert_eq!(
        tree.command()
            .arg("--verify-manifest")
            .arg(&manifest)
            .status()
            .unwrap()
            .code(),
        Some(2)
    );
    assert_eq!(fs::read(&manifest).unwrap(), original);
}
#[cfg(unix)]
#[test]
fn existing_output_symlink_and_manifest_are_not_followed_or_replaced() {
    use std::os::unix::fs::symlink;
    let tree = Tree::new();
    let foreign = tree.0.join("foreign");
    fs::write(&foreign, b"foreign").unwrap();
    symlink(&foreign, tree.0.join("task-perf-seccomp.json")).unwrap();
    assert!(!tree.command().status().unwrap().success());
    assert_eq!(fs::read(&foreign).unwrap(), b"foreign");
    fs::remove_file(tree.0.join("task-perf-seccomp.json")).unwrap();
    fs::write(tree.0.join("worker-perf-profile.json"), b"retained").unwrap();
    assert!(!tree.command().status().unwrap().success());
    assert_eq!(
        fs::read(tree.0.join("worker-perf-profile.json")).unwrap(),
        b"retained"
    );
}
