#![cfg(unix)]

use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::symlink,
    path::{Path, PathBuf},
    process::{Command, Output},
};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path =
            nix::unistd::mkdtemp(&std::env::temp_dir().join("rv-oc-install-XXXXXX")).unwrap();
        symlink(
            env!("CARGO_BIN_EXE_reverie-admin-memory"),
            path.join("reverie-opencode"),
        )
        .unwrap();
        Self(path)
    }

    fn run(&self, workspace: &Path, flags: &[&str]) -> Output {
        Command::new(self.0.join("reverie-opencode"))
            .env_clear()
            .arg("--install")
            .arg(workspace)
            .args(flags)
            .output()
            .unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn data(path: impl AsRef<Path>) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

#[test]
fn native_cli_installs_scoped_profiles_without_a_python_environment() {
    let fixture = Fixture::new();
    let workspace = fixture.0.join("workspace");
    let instance = fixture.0.join("Jules' instance.json");
    fs::write(
        &instance,
        json!({
            "id":"employee-fixture", "agent_name":"Rêverie", "owner_name":"Owner",
            "role":"Researcher","kind":"cto", "persona":"A bounded assistant.", "data_dir":"state",
        })
        .to_string(),
    )
    .unwrap();
    let output = fixture.run(
        &workspace,
        &[
            "--instance",
            instance.to_str().unwrap(),
            "--model",
            "local/model",
            "--api-base",
            "http://127.0.0.1:8888/v1/",
            "--api-key-env",
            "MODEL_KEY",
        ],
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap()["model"],
        "local/model"
    );
    let marker = data(workspace.join(".reverie-instance"));
    assert_eq!(marker["bridge"], "reverie-opencode-bridge");
    assert!(marker.get("python").is_none() && marker.get("source").is_none());
    assert_eq!(
        marker["instance"],
        instance.canonicalize().unwrap().to_str().unwrap()
    );
    let config = data(workspace.join("opencode.json"));
    assert_eq!(config["default_agent"], "chat");
    assert_eq!(
        config["provider"]["local"]["options"]["apiKey"],
        "{env:MODEL_KEY}"
    );
    assert_eq!(
        config["provider"]["local"]["options"]["baseURL"],
        "http://127.0.0.1:8888/v1"
    );
    assert_eq!(config["agent"]["chat"]["permission"]["*"], "deny");
    assert_eq!(config["agent"]["coding"]["permission"]["bash"], "ask");
    assert!(
        config["agent"]["chat"]["prompt"]
            .as_str()
            .unwrap()
            .contains("Rêverie")
    );
    let instructions = fs::read_to_string(workspace.join("AGENTS.md")).unwrap();
    assert!(
        instructions.contains("'Jules'\"'\"' instance.json")
            || instructions.contains("/Jules'\"'\"' instance.json")
    );
    assert!(
        workspace
            .join(".claude/skills/reverie-memory/SKILL.md")
            .is_file()
    );
    assert!(!fixture.0.join("state").exists());
}

#[test]
fn native_install_respects_owner_policy_and_unmanaged_files() {
    let fixture = Fixture::new();
    let workspace = fixture.0.join("workspace");
    fs::create_dir(&workspace).unwrap();
    let config = workspace.join("opencode.json");
    fs::write(&config, b"owner configuration").unwrap();
    assert!(!fixture.run(&workspace, &[]).status.success());
    assert_eq!(fs::read_to_string(&config).unwrap(), "owner configuration");
    fs::remove_file(&config).unwrap();
    assert!(
        !fixture
            .run(
                &workspace,
                &["--api-base", "https://user:password@example.org/v1"]
            )
            .status
            .success()
    );
    assert!(!config.exists());
    assert!(fixture.run(&workspace, &[]).status.success());
    let policy = workspace.join(".opencode/interaction-policy.json");
    fs::write(
        &policy,
        r#"{"enabled":false, "coding_agent":"owner-profile"}"#,
    )
    .unwrap();
    let obsolete = workspace.join(".opencode/plugins/reverie.mjs");
    fs::write(&obsolete, "legacy managed duplicate").unwrap();
    assert!(
        fixture
            .run(&workspace, &["--model", "provider/model"])
            .status
            .success()
    );
    assert_eq!(
        data(&policy),
        json!({"enabled":false,"coding_agent":"owner-profile"})
    );
    assert!(!obsolete.exists());
    assert_eq!(data(config)["model"], "provider/model");
}
