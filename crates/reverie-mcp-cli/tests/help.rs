//! Actual CLI parsing must finish before any installation/context read.
use std::{fs, path::PathBuf, process::Command, time::SystemTime};
struct Home(PathBuf);
impl Home {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "reverie-mcp-help-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        Self(root)
    }
    fn command(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_reverie-mcp"));
        command.env_clear().env("HOME", &self.0);
        command
    }
}
impl Drop for Home {
    fn drop(&mut self) {
        fs::remove_dir(&self.0).unwrap();
    }
}
#[test]
fn help_explains_scope_without_initializing_home() {
    let home = Home::new();
    let output = home.command().arg("--help").output().unwrap();
    assert!(output.status.success(), "{output:?}");
    let text = String::from_utf8(output.stdout).unwrap();
    for required in [
        "Usage:",
        "--chat",
        "--url",
        "Permissions:",
        "Recovery:",
        "Office",
        "never initializes",
    ] {
        assert!(text.contains(required), "missing {required}: {text}");
    }
    assert_eq!(fs::read_dir(&home.0).unwrap().count(), 0);
}
#[test]
fn unknown_arguments_refuse_before_bootstrap() {
    let home = Home::new();
    for argument in ["--program", "--instance", "--context", "--python"] {
        let output = home.command().arg(argument).output().unwrap();
        assert_eq!(output.status.code(), Some(2), "{output:?}");
        assert!(output.stdout.is_empty());
    }
    assert_eq!(fs::read_dir(&home.0).unwrap().count(), 0);
}
