#![cfg(unix)]

use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::symlink,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
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

    fn instance(&self) -> PathBuf {
        let instance = self.0.join("instance.json");
        fs::write(
            &instance,
            json!({"id": "fixture", "agent_name":"Fixture", "owner_name":"Owner",
                   "persona":"Check sources.", "data_dir":"state"})
            .to_string(),
        )
        .unwrap();
        instance
    }

    fn bridge(&self, instance: &Path, request: Value) -> Output {
        self.bridge_with(instance, request, |_| ())
    }

    fn bridge_with(
        &self,
        instance: &Path,
        request: Value,
        configure: impl FnOnce(&mut Command),
    ) -> Output {
        let mut command = Command::new(self.0.join("reverie-opencode"));
        command
            .env_clear()
            .env("REVERIE_ROOT", &self.0)
            .args(["--bridge", "--instance"])
            .arg(instance)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        configure(&mut command);
        let mut child = command.spawn().unwrap();
        serde_json::to_writer(child.stdin.take().unwrap(), &request).unwrap();
        child.wait_with_output().unwrap()
    }
}

#[path = "support/opencode_maintenance.rs"]
mod maintenance;
#[path = "support/opencode_memory.rs"]
mod memory;

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn data(path: impl AsRef<Path>) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

fn reply(output: Output) -> Value {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn native_activity_refuses_remote_endpoints_and_isolates_research() {
    let fixture = Fixture::new();
    let instance = fixture.instance();
    let request = |url| {
        json!({"action":"activity","runtime":{
            "url":url,"session_id":"ses_fixture","directory":"/workspace"
        }})
    };
    for remote in [
        "https://localhost:3000",
        "http://example.org",
        "http://user@localhost",
    ] {
        assert!(!fixture.bridge(&instance, request(remote)).status.success());
    }
    let result = reply(fixture.bridge(
        &instance,
        json!({"action":"activity","research_cycle_id":"research-fixture"}),
    ));
    assert_eq!(result, json!({"ok":true,"research":true}));
    let mode = reply(fixture.bridge(&instance, json!({"action":"mode"})));
    assert_eq!(mode, json!({"mode":"active"}));
    assert!(!fixture.0.join("state").exists());
    assert_eq!(
        reply(fixture.bridge(&instance, request("http://[::1]:3000"))),
        json!({"ok":true})
    );
    let store =
        reverie_store::memory::MemoryStore::open(fixture.0.join("state/memory.sqlite")).unwrap();
    let runtime = store.get_state("reverie_runtime", None).unwrap().unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&runtime).unwrap(),
        request("http://[::1]:3000")["runtime"]
    );
    assert!(
        store
            .get_state("reverie_last_activity", None)
            .unwrap()
            .unwrap()
            .parse::<f64>()
            .unwrap()
            > 0.0
    );
    store.close().unwrap();
}

#[test]
fn native_state_reuses_plan_revisions_profiles_and_briefing() {
    let fixture = Fixture::new();
    let instance = fixture.instance();
    let initial = reply(fixture.bridge(&instance, json!({"action":"plan"})));
    assert_eq!(initial["revision"], 0);
    assert!(initial.get("updated_at").is_none());
    let write = || {
        fixture.bridge(
            &instance,
            json!({"action":"plan","revision":0,"text":"Keep the build green."}),
        )
    };
    assert_eq!(reply(write())["revision"], 1);
    assert!(!write().status.success());
    assert_eq!(
        reply(fixture.bridge(&instance, json!({"action":"plan"})))["body"],
        "Keep the build green."
    );
    let profile = reply(fixture.bridge(&instance, json!({
        "action":"profile","name":"compiler","revision":0,
        "profile":{"role":"Compiler maintainer","short_term":"Check the parser","memory_queries":["grammar"]}
    })));
    let profiles = reply(fixture.bridge(&instance, json!({"action":"profiles"})));
    assert_eq!(profiles["compiler"], profile);
    let brief = reply(fixture.bridge(
        &instance,
        json!({
            "action":"brief","names":["compiler"],"task":"Review the grammar"
        }),
    ));
    assert!(brief.as_str().unwrap().contains("Compiler maintainer"));
    assert!(brief.as_str().unwrap().contains("Review the grammar"));
}

#[test]
fn native_self_changes_still_require_recorded_core_ballots() {
    let fixture = Fixture::new();
    let instance = fixture.instance();
    let initial = reply(fixture.bridge(&instance, json!({"action":"self"})));
    assert_eq!(initial["revision"], 1);
    let mut model = initial["body"].clone();
    model["persona"] = json!("I protect existing data.");
    let set = |model, revision| {
        fixture.bridge(
            &instance,
            json!({"action":"self","model":model,"reason":"fixture","revision":revision}),
        )
    };
    let initialized = reply(set(model.clone(), 1));
    assert_eq!(initialized["revision"], 2);
    let mut other = model;
    other["consciousness"] = json!("Review plans.");
    assert!(!set(other.clone(), 2).status.success());
    let vote = reply(fixture.bridge(
        &instance,
        json!({"action":"self_vote","model":other,"reason":"fixture"}),
    ));
    assert_eq!(vote["ballot"]["consecutive_weeks"], 1);
    assert_eq!(vote["ballot"]["approved"], false);
    assert_eq!(vote["self"], initialized);
    assert_eq!(
        reply(fixture.bridge(&instance, json!({"action":"votes"})))[0]["category"],
        "core"
    );
}

#[test]
fn native_record_preserves_turn_identity_and_the_project_scope_on_retry() {
    let fixture = Fixture::new();
    let instance = fixture.instance();
    let mut request = json!({"action":"record","source_id":"opencode:session:turn","user":"Build status?",
                            "reply":"The test passed.","visibility":"project"});
    let result = reply(fixture.bridge(&instance, request.clone()));
    request["reply"] = json!("A second reply");
    request["visibility"] = json!("private");
    assert_eq!(reply(fixture.bridge(&instance, request)), result);

    let store =
        reverie_store::memory::MemoryStore::open(fixture.0.join("state/memory.sqlite")).unwrap();
    let record = store.get(result["memory_id"].as_i64().unwrap()).unwrap();
    let record: Value = serde_json::from_slice(record.as_dict().as_json()).unwrap();
    assert_eq!(record["assistant_text"], "The test passed.");
    assert_eq!(record["meta"]["visibility"], "project");
    store.close().unwrap();
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
