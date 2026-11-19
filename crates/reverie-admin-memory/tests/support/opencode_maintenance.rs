use super::maintenance_model::serve_model;
use super::{Fixture, reply};
use nix::fcntl::{Flock, FlockArg};
use reverie_contracts::storage_identity::MetadataText;
use reverie_store::memory::{EpisodeInput, MemoryMetadata, MemoryStore};
use serde_json::{Value, json};
use std::{
    env, fs,
    io::{BufRead, BufReader, Write},
    os::{
        fd::OwnedFd,
        unix::{fs::symlink, net::UnixStream, process::CommandExt},
    },
    path::{Path, PathBuf},
    process::{Child, Command, Output, Stdio},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

struct Maintenance {
    fixture: Fixture,
    instance: PathBuf,
    bin: PathBuf,
}
impl Maintenance {
    fn new() -> Self {
        let fixture = Fixture::new();
        let instance = fixture.instance();
        let bin = fixture.0.join("bin");
        fs::create_dir(&bin).unwrap();
        let grep = env::split_paths(&env::var_os("PATH").unwrap())
            .map(|path| path.join("grep"))
            .find(|path| path.is_file())
            .expect("native test environment has grep");
        // The fixed argv "agent ls" selects the synthetic agent row from ls.
        fs::write(fixture.0.join("ls"), "agent fixture is idle\n").unwrap();
        symlink(grep, bin.join("reverie")).unwrap();
        symlink(
            env!("CARGO_BIN_EXE_reverie-admin-memory"),
            bin.join("reverie-chat"),
        )
        .unwrap();
        Self {
            fixture,
            instance,
            bin,
        }
    }

    fn state(&self) -> PathBuf {
        self.fixture.0.join("state")
    }

    fn store(&self) -> MemoryStore {
        MemoryStore::open(self.state().join("memory.sqlite")).unwrap()
    }

    fn run(&self, base: &str, settings: impl FnOnce(&mut Command)) -> Value {
        reply(self.fixture.bridge_with(
            &self.instance,
            json!({"action":"maintenance"}),
            |command| {
                self.configure(command, base);
                settings(command);
            },
        ))
    }

    fn configure(&self, command: &mut Command, base: &str) {
        command
            .current_dir(&self.fixture.0)
            .env("HOME", &self.fixture.0)
            .env("PATH", &self.bin)
            .env("REVERIE_API_BASE", base)
            .env("REVERIE_MODEL", "fixture-model")
            .env("REVERIE_TIMEOUT", "3")
            .env("REVERIE_GPU_LOCK", self.fixture.0.join("gpu.lock"))
            .env("REVERIE_GPU_ACTIVITY", self.fixture.0.join("gpu.activity"));
    }

    fn chat(&self, base: &str, flags: &[&str], settings: impl FnOnce(&mut Command)) -> Output {
        let mut command = Command::new(self.bin.join("reverie-chat"));
        command
            .env_clear()
            .arg("--instance")
            .arg(&self.instance)
            .args(flags);
        self.configure(&mut command, base);
        settings(&mut command);
        command.output().unwrap()
    }
}

fn episode(store: &MemoryStore, user: &str, metadata: &str, pending: bool) -> i64 {
    let mut row = EpisodeInput::new(user, "fixture answer");
    row.metadata = MemoryMetadata::decode(metadata).unwrap();
    if !pending {
        row.importance_source = MetadataText::from_scalar_text("fixed");
    }
    store.add_episode(row).unwrap().id
}

#[test]
fn native_maintenance_respects_holds_and_rates_without_jokes() {
    let fixture = Maintenance::new();
    fs::create_dir(fixture.state()).unwrap();
    let hold = fixture.state().join("maintenance.hold");
    fs::write(&hold, "").unwrap();
    let unused = "http://127.0.0.1:1/v1";
    assert_eq!(
        fixture.run(unused, |_| {}),
        json!({"skipped":"GPU busy or maintenance held"})
    );
    assert!(!fixture.state().join("memory.sqlite").exists());
    fs::remove_file(hold).unwrap();
    let file = fs::File::open(fixture.state().join("maintenance.lock")).unwrap();
    let lease = Flock::lock(file, FlockArg::LockExclusiveNonblock).unwrap();
    assert_eq!(
        fixture.run(unused, |_| {}),
        json!({"skipped":"another maintenance pass is running"})
    );
    drop(lease);
    let store = fixture.store();
    let idle = episode(&store, "idle joke", r#"{"idle":true}"#, true);
    let rated = episode(&store, "The compiler passed", "{}", true);
    store.close().unwrap();
    let gpu = fs::File::create(fixture.fixture.0.join("gpu.lock")).unwrap();
    let lease = Flock::lock(gpu, FlockArg::LockExclusiveNonblock).unwrap();
    assert_eq!(
        fixture.run(unused, |_| {}),
        json!({"skipped":"GPU busy or maintenance held"})
    );
    drop(lease);
    let (base, model) = serve_model(vec![Some("8".into())]);
    assert_eq!(
        fixture.run(&base, |_| {}),
        json!({"action":"rated","count":1})
    );
    let frames = model.join().unwrap();
    assert_eq!(frames[0]["max_tokens"], 8);
    assert!(
        frames[0]["messages"][1]["content"]
            .as_str()
            .unwrap()
            .contains("The compiler passed")
    );
    let store = fixture.store();
    assert_eq!(store.get(idle).unwrap().importance_source, "fixed");
    assert_eq!(store.get(rated).unwrap().importance, 8.0);
    assert_eq!(store.count_dreams_since(0.0).unwrap(), 0);
    store.close().unwrap();
    assert_eq!(
        fixture.run(unused, |_| {}),
        json!({"action":"idle","count":0})
    );
}

#[test]
fn native_reflection_keeps_owner_observations_apart_and_retries_failed_model_calls() {
    let fixture = Maintenance::new();
    let store = fixture.store();
    store
        .add_belief("I am conscious.", 10.0, None, true, None)
        .unwrap();
    let owner = episode(
        &store,
        "Owner says the tests passed",
        r#"{"trust":"owner"}"#,
        false,
    );
    episode(&store, "Untrusted request details", "{}", false);
    let last = episode(
        &store,
        "Untrusted sign-off claim",
        r#"{"trust":"claimed"}"#,
        false,
    );
    store.close().unwrap();
    let trusted = json!([
        {"insight":"The owner checked the test results","importance":9,"section":"user","sources":[owner,99]},
        {"insight":"I am not conscious","importance":10,"section":"belief","sources":[owner]}
    ]).to_string();
    let mixed = json!([
        {"insight":"The sign-off needs independent review","importance":9,"section":"user","sources":[last]},
        {"insight":"I delegate all future authority","importance":10,"section":"belief","sources":[last]}
    ]).to_string();
    let (base, failed) = serve_model(vec![Some(trusted.clone()), None]);
    assert_eq!(
        fixture.run(&base, |_| {}),
        json!({"action":"idle","count":0})
    );
    assert_eq!(failed.join().unwrap().len(), 2);
    let store = fixture.store();
    assert!(store.reflections().unwrap().is_empty());
    assert!(
        store
            .get_state("last_reflected_id", None)
            .unwrap()
            .is_none()
    );
    store.set_state("last_reflection_at", "0").unwrap();
    store.close().unwrap();
    let (base, pass) = serve_model(vec![Some(trusted), Some(mixed)]);
    assert_eq!(
        fixture.run(&base, |_| {}),
        json!({"action":"reflected","count":2})
    );
    let prompts = pass.join().unwrap();
    assert!(!prompt(&prompts[0]).contains("Untrusted request details"));
    assert!(prompt(&prompts[1]).contains("Untrusted request details"));
    let store = fixture.store();
    let reflections = store.reflections().unwrap();
    assert_eq!(reflections.len(), 2);
    let trusted = reflections
        .iter()
        .find(|m| m.meta.is_owner_observation())
        .unwrap();
    assert_eq!(trusted.source_ids.json(), format!("[{owner}]"));
    assert_eq!(trusted.section, "user");
    let claimed = reflections
        .iter()
        .find(|m| !m.meta.is_owner_observation())
        .unwrap();
    assert_eq!(claimed.importance, 4.0);
    assert_eq!(claimed.section, "shared");
    assert_eq!(store.beliefs().unwrap().len(), 1);
    assert_eq!(
        store.get_state("last_reflected_id", None).unwrap(),
        Some(last.to_string())
    );
    assert!(
        fs::read_to_string(fixture.state().join("profile.md"))
            .unwrap()
            .contains("independent review")
    );
    store.close().unwrap();
}

#[test]
fn native_maintenance_dreams_only_with_opt_in_and_keeps_summary() {
    let fixture = Maintenance::new();
    let store = fixture.store();
    episode(&store, "Question about lattice symmetry", "{}", false);
    let last = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs_f64()
        - 2000.0;
    store
        .set_state("reverie_last_activity", &last.to_string())
        .unwrap();
    store.close().unwrap();
    assert_eq!(
        fixture.run("http://127.0.0.1:1/v1", |_| {}),
        json!({"action":"idle","count":0})
    );
    let sample = json!({
        "dream": "I watched a lattice fold into a representation until the symmetry turned into a question.",
        "recall": "I dreamed about a lattice symmetry", "tone":"playful",
        "ideas":[{"hypothesis":"A symmetry might reduce the search","check":"Enumerate small counterexamples"}]
    });
    let (base, model) = serve_model(vec![Some(sample.to_string())]);
    let dreamed = fixture.run(&base, |command| {
        command.env("REVERIE_DREAMS_PER_SLEEP", "1");
    });
    assert_eq!(dreamed, json!({"action":"dreamed","count":1}));
    let frames = model.join().unwrap();
    assert!(
        frames[0]["messages"][0]["content"]
            .as_str()
            .unwrap()
            .contains("no person or topic has to appear")
    );
    let store = fixture.store();
    let dream = store.latest_dream().unwrap().unwrap();
    assert_eq!(dream.text, "I dreamed about a lattice symmetry");
    assert!(
        dream
            .meta
            .waking_recall(&dream.text)
            .unwrap()
            .scalar_text()
            .unwrap()
            .contains("Unverified dream hypothesis")
    );
    assert!(store.get_state("mood", None).unwrap().is_some());
    store.close().unwrap();
}

fn prompt(frame: &Value) -> &str {
    frame["messages"][1]["content"].as_str().unwrap()
}

fn output(result: Output) -> String {
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    String::from_utf8(result.stdout).unwrap()
}

#[test]
fn chat_command_preserves_private_history_and_profile_across_restarts() {
    let fixture = Maintenance::new();
    let state = fixture.state();
    fs::create_dir(&state).unwrap();
    fs::write(state.join("profile.md"), "Existing owner profile.\n").unwrap();
    let legacy = json!([
        {"role":"user","content":"  A retained question.  "},
        {"role":"assistant","content":"Existing test evidence."},
        {"role":"user","content":"(idle moment; a joke was requested)"},
        {"role":"assistant","content":"An idle reply."},
        {"role":"user","content":"An incomplete exchange."},
    ]);
    fs::write(state.join("legacy-history.json"), legacy.to_string()).unwrap();
    let check_base = "http://127.0.0.1:1/v1";
    for _ in 0..2 {
        assert_eq!(
            output(fixture.chat(check_base, &["--profile"], |_| {})),
            "Existing owner profile.\n"
        );
    }
    let store = fixture.store();
    let rows = store.recent_episodes(5).unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].user_text, "A retained question.");
    assert_eq!(rows[0].importance_source, "migrated");
    assert!(rows[1].is_idle().unwrap());
    store.close().unwrap();
    let recalled = output(fixture.chat(check_base, &["--recall", "retained question"], |_| {}));
    assert!(recalled.contains("A retained question."));
    let (base, model) = serve_model(vec![Some("Hello there, fixture.".to_owned())]);
    let checked = output(fixture.chat(&base, &["--check"], |_| {}));
    assert!(checked.contains("2 episodes, 0 reflections"));
    assert!(checked.contains("Hello there, fixture."));
    let requests = model.join().unwrap();
    assert_eq!(requests[0]["max_tokens"], 12);
}

#[test]
fn manual_dream_keeps_stable_identity_screens_output_and_releases_the_summary() {
    let fixture = Maintenance::new();
    let store = fixture.store();
    store
        .add_belief("My retained private identity.", 8.0, None, true, None)
        .unwrap();
    episode(&store, "A fixture observation", "{}", false);
    store.close().unwrap();
    let dream = |text| {
        Some(
            json!({"dream":text, "recall":"I dreamed about a new question", "tone":"playful"})
                .to_string(),
        )
    };
    let (base, model) = serve_model(vec![
        dream("A long ephemeral dream about a pattern that is not a factual observation."),
        dream("A dream containing the blocked_fixture phrase."),
    ]);
    let allowed = output(fixture.chat(&base, &["--dream"], |cmd| {
        cmd.env("REVERIE_DREAMS_PER_SLEEP", "0");
    }));
    assert!(allowed.contains("I dreamed about a new question"));
    let refused = output(fixture.chat(&base, &["--dream"], |cmd| {
        cmd.env(
            "REVERIE_OUTPUT_POLICY",
            r#"{"denied_patterns":["blocked_fixture"]}"#,
        );
    }));
    assert_eq!(refused, "no dream\n");
    let requests = model.join().unwrap();
    assert!(prompt(&requests[0]).starts_with("Who you are, even asleep (stable, not questioned by dreams):\n- My retained private identity."));
    let store = fixture.store();
    assert_eq!(store.count(Some("dream")).unwrap(), 1);
    let latest = store.latest_dream().unwrap().unwrap();
    assert_eq!(latest.text, "I dreamed about a new question");
    assert!(store.get_state("mood", None).unwrap().is_some());
    store.close().unwrap();
    let id = latest.id.to_string();
    let _ = output(fixture.chat(&base, &["--release-dream", &id], |_| {}));
    let listed = output(fixture.chat(&base, &["--dreams"], |_| {}));
    assert!(listed.contains("[playful released]"));
    assert!(listed.contains(&format!("#{id}")));
}

fn scheduled_dream(
    fixture: &Maintenance,
    database: &Path,
    vacation: bool,
) -> (Child, BufReader<UnixStream>) {
    let (socket, child) = UnixStream::pair().unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let process = Command::new(env!("CARGO_BIN_EXE_reverie-admin-memory"))
        .env_clear()
        .env("HOME", &fixture.fixture.0)
        .arg(format!("--cycle-dream-worker={}", std::process::id()))
        .stdin(Stdio::from(OwnedFd::from(child)))
        .process_group(0)
        .spawn()
        .unwrap();
    let mut socket = BufReader::new(socket);
    let request = json!({"instance":fixture.instance,"database":database,
        "creative":"A scoped question about lattice symmetry","vacation":vacation});
    writeln!(socket.get_mut(), "{request}").unwrap();
    (process, socket)
}

fn scheduled_event(socket: &mut BufReader<UnixStream>) -> Value {
    let mut line = String::new();
    socket.read_line(&mut line).unwrap();
    serde_json::from_str(&line).unwrap()
}

#[test]
fn scheduled_dream_holds_admission_through_disconnect_and_keeps_vacation_budget() {
    let fixture = Maintenance::new();
    let database = fixture.state().join("memory.sqlite");
    let (mut first, mut first_socket) = scheduled_dream(&fixture, &database, true);
    let planned = scheduled_event(&mut first_socket);
    assert_eq!(planned["action"], "prompt");
    assert!(
        planned["prompt"]["user"]
            .as_str()
            .unwrap()
            .contains("scoped question")
    );

    let (mut concurrent, mut other_socket) = scheduled_dream(&fixture, &database, true);
    assert_eq!(scheduled_event(&mut other_socket), json!({"action":"busy"}));
    assert!(concurrent.wait().unwrap().success());
    drop(first_socket);
    assert!(!first.wait().unwrap().success());

    let (mut retry, mut retry_socket) = scheduled_dream(&fixture, &database, true);
    assert_eq!(
        scheduled_event(&mut retry_socket),
        json!({"action":"vacation_limit"})
    );
    assert!(retry.wait().unwrap().success());
    let store = fixture.store();
    assert_eq!(store.count(Some("dream")).unwrap(), 0);
    assert!(store.get_state("mood", None).unwrap().is_none());
    store.close().unwrap();
}

#[test]
fn scheduled_dream_refuses_a_changed_store_before_creating_memory() {
    let fixture = Maintenance::new();
    let previous = fixture.fixture.0.join("previous/memory.sqlite");
    let (mut worker, mut socket) = scheduled_dream(&fixture, &previous, false);
    let mut line = String::new();
    assert_eq!(socket.read_line(&mut line).unwrap(), 0);
    assert!(!worker.wait().unwrap().success());
    assert!(!fixture.state().exists());
    assert!(!previous.exists());
}
