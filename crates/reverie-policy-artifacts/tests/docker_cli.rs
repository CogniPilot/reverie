use std::{fs, path::PathBuf, process::Command};
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("reverie-docker-profile-{}", std::process::id()));
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
            .arg("--docker-profile-output")
            .arg(self.0.join("output.json"));
        command
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
#[test]
fn actual_docker_mode_excludes_perf_mode_refuses_foreign_outputs_and_preserves_bytes() {
    let tree = Tree::new();
    for arguments in [
        vec!["--system", "x86_64-linux"],
        vec!["--output-directory", "."],
    ] {
        assert_eq!(
            tree.command().args(arguments).status().unwrap().code(),
            Some(2)
        );
        assert!(!tree.0.join("output.json").exists());
    }
    assert!(tree.command().status().unwrap().success());
    let expected = reverie_contracts::docker_profile::produce_docker_profile(
        &fs::read(tree.0.join("base.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(fs::read(tree.0.join("output.json")).unwrap(), expected);
    assert!(!tree.command().status().unwrap().success());
    assert_eq!(fs::read(tree.0.join("output.json")).unwrap(), expected);
    fs::remove_file(tree.0.join("output.json")).unwrap();
    #[cfg(unix)]
    {
        fs::write(tree.0.join("foreign"), b"foreign").unwrap();
        std::os::unix::fs::symlink(tree.0.join("foreign"), tree.0.join("output.json")).unwrap();
        assert!(!tree.command().status().unwrap().success());
        assert_eq!(fs::read(tree.0.join("foreign")).unwrap(), b"foreign");
        fs::remove_file(tree.0.join("output.json")).unwrap();
    }
    fs::write(
        tree.0.join("base.json"),
        br#"{"defaultAction":"SCMP_ACT_ALLOW","syscalls":[]}"#,
    )
    .unwrap();
    assert!(!tree.command().status().unwrap().success());
    assert!(!tree.0.join("output.json").exists());
}
