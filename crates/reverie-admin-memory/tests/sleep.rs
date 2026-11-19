#![cfg(unix)]

use reverie_store::memory::MemoryStore;
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::symlink,
    path::{Path, PathBuf},
    process::{Command, Output},
};

#[path = "support/sleep_history.rs"]
mod history;
#[path = "support/sleep_maintenance.rs"]
mod maintenance;
#[path = "support/maintenance_model.rs"]
mod maintenance_model;
#[path = "support/sleep_prune.rs"]
mod prune;

const EMPLOYEE: &str = "00000001-0000-4000-8000-00000000000a";
const OTHER: &str = "00000002-0000-4000-8000-00000000000a";

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let root = nix::unistd::mkdtemp(&std::env::temp_dir().join("rv-sleep-XXXXXX")).unwrap();
        symlink(
            env!("CARGO_BIN_EXE_reverie-admin-memory"),
            root.join("reverie-sleep"),
        )
        .unwrap();
        write(&root.join("chat.json"), &json!([]));
        Self(root)
    }

    fn agent(&self, name: &str, employee: Option<&str>, hold: bool) -> Value {
        let path = self.0.join(format!("{name}.json"));
        let mut config = json!({
            "id":name, "agent_name":name,"owner_name":"Owner","data_dir":name,
            "persona":"Check sources."
        });
        if let Some(employee) = employee {
            config["employee_id"] = json!(employee);
        }
        write(&path, &config);
        if hold {
            fs::create_dir(self.0.join(name)).unwrap();
            fs::write(self.0.join(name).join("maintenance.hold"), "").unwrap();
        }
        json!({"name":name, "instance":path, "session_id":"S1"})
    }

    fn policy(&self, agents: &[Value]) -> Value {
        json!({"timezone":"UTC", "window":{"start":"01:00","end":"01:00"}, "dry_run":false,
               "chatrooms":self.0.join("chat.json"), "state_dir":self.0.join("policy-state"), "agents":agents})
    }

    fn run(&self, action: &str, policy: &Value, configure: impl FnOnce(&mut Command)) -> Output {
        let config = self.0.join("policy.json");
        write(&config, policy);
        let mut command = Command::new(self.0.join("reverie-sleep"));
        command
            .env_clear()
            .current_dir(&self.0)
            .env("HOME", &self.0)
            .env("REVERIE_ROOT", &self.0)
            .env("REVERIE_EMBED_URL", "")
            .env("REVERIE_API_BASE", "http://127.0.0.1:1/v1")
            .args([action, "--policy"])
            .arg(config);
        configure(&mut command);
        command.output().unwrap()
    }

    fn tick(&self, policy: &Value) -> String {
        success(self.run("tick", policy, |_| ()))
    }

    fn store(&self, name: &str) -> MemoryStore {
        MemoryStore::open(self.0.join(name).join("memory.sqlite")).unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn write(path: &Path, value: &Value) {
    fs::write(path, serde_json::to_vec(value).unwrap()).unwrap();
}

fn success(output: Output) -> String {
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

#[test]
fn legacy_defaults_and_validation_are_available_through_the_packaged_command() {
    let fixture = Fixture::new();
    let mut policy = fixture.policy(&[fixture.agent("expert", None, false)]);
    policy.as_object_mut().unwrap().remove("dry_run");
    let check = success(fixture.run("check-policy", &policy, |_| ()));
    assert!(check.contains("policy ok: 1 agents, dry-run"));
    assert!(check.contains("deprecated_session_ids expert"));
    assert!(!fixture.0.join("policy-state").exists());
    for bad in [
        json!({"chat_db":fixture.0.join("second.db")}),
        json!({"timezone":"Mars/Base"}),
        json!({"window":{"start":"25:00","end":"01:00"}}),
        json!({"state_dir":"relative"}),
        json!({"prune":[{"path":"/logs/example","days":0}]}),
        json!({"agents":[]}),
        json!({"agents":[{"name":"../a","instance":"/i","session_id":"S1"}]}),
        json!({"agents":[{"name":"expert","instance":"/i","employee_id":"MALFORMED"}]}),
        json!({"agents":[{"name":"expert","instance":"/i","employee_id":EMPLOYEE}]}),
        json!({"agents":[{"name":"expert","instance":"/i","session_ids":[""]}]}),
        json!({"agents":[{"name":"expert","instance":"/i"}]}),
        json!({"surprise":true}),
    ] {
        let mut trial = policy.clone();
        trial
            .as_object_mut()
            .unwrap()
            .extend(bad.as_object().unwrap().clone());
        let refused = fixture.run("tick", &trial, |_| ());
        assert_eq!(refused.status.code(), Some(2), "{trial}");
        assert!(String::from_utf8_lossy(&refused.stdout).contains("policy_refused"));
    }
}

#[test]
fn tick_and_agent_locks_use_the_existing_flock_names() {
    use nix::fcntl::{Flock, FlockArg};
    let fixture = Fixture::new();
    let mut agent = fixture.agent("expert", None, false);
    agent["consolidate"] = json!(false);
    let policy = fixture.policy(&[agent]);
    let dir = fixture.0.join("policy-state");
    fs::create_dir(&dir).unwrap();
    let tick = Flock::lock(
        fs::File::create(dir.join("sleep.lock")).unwrap(),
        FlockArg::LockExclusive,
    )
    .unwrap();
    assert_eq!(fixture.tick(&policy), "sleep v1 previous_tick_running\n");
    assert!(!dir.join("sleep.log").exists());
    drop(tick);
    let _agent = Flock::lock(
        fs::File::create(dir.join("sleep-expert.lock")).unwrap(),
        FlockArg::LockExclusive,
    )
    .unwrap();
    let output = fixture.tick(&policy);
    assert!(output.contains("locked expert 0 live"));
    assert_eq!(fs::read_to_string(dir.join("sleep.log")).unwrap(), output);
    assert!(!fixture.0.join("expert").exists());
}
