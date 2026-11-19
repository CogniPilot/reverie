use super::{Fixture, reply};
use nix::fcntl::{Flock, FlockArg};
use reverie_contracts::storage_identity::MetadataText;
use reverie_store::memory::{EpisodeInput, MemoryMetadata, MemoryStore};
use serde_json::{Value, json};
use std::{
    env, fs,
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    os::unix::fs::symlink,
    path::PathBuf,
    process::Command,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
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
                command
                    .current_dir(&self.fixture.0)
                    .env("PATH", &self.bin)
                    .env("REVERIE_API_BASE", base)
                    .env("REVERIE_MODEL", "fixture-model")
                    .env("REVERIE_TIMEOUT", "3")
                    .env("REVERIE_GPU_LOCK", self.fixture.0.join("gpu.lock"))
                    .env("REVERIE_GPU_ACTIVITY", self.fixture.0.join("gpu.activity"));
                settings(command);
            },
        ))
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

fn serve_model(replies: Vec<Option<String>>) -> (String, thread::JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let task = thread::spawn(move || {
        let mut requests = Vec::new();
        for reply in replies {
            let mut client = accept(&listener);
            client
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            requests.push(read_request(&mut client));
            let (status, body) = match reply {
                Some(text) => (
                    "200 OK",
                    json!({"choices":[{"message":{"content":text}}]}).to_string(),
                ),
                None => ("503 Unavailable", "{}".to_owned()),
            };
            write!(client, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}", body.len()).unwrap();
        }
        requests
    });
    (base, task)
}

fn accept(listener: &TcpListener) -> TcpStream {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match listener.accept() {
            Ok((stream, _)) => return stream,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                assert!(Instant::now() < deadline, "model request did not arrive");
                thread::sleep(Duration::from_millis(5));
            }
            Err(error) => panic!("{error}"),
        }
    }
}

fn read_request(client: &mut TcpStream) -> Value {
    let mut reader = BufReader::new(client);
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    assert!(line.starts_with("POST /v1/chat/completions "));
    let mut len = None;
    loop {
        line.clear();
        assert_ne!(reader.read_line(&mut line).unwrap(), 0);
        if line == "\r\n" {
            break;
        }
        if let Some((key, value)) = line.split_once(':')
            && key.eq_ignore_ascii_case("content-length")
        {
            len = Some(value.trim().parse().unwrap());
        }
    }
    let mut body = vec![0; len.unwrap()];
    reader.read_exact(&mut body).unwrap();
    serde_json::from_slice(&body).unwrap()
}
