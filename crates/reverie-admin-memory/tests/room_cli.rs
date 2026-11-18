#![cfg(feature = "test-fixtures")]
use reverie_store::memory::MemoryStore;
use serde_json::{Value, json};
use std::{
    env, fs,
    io::Write,
    os::unix::{
        fs::{DirBuilderExt, PermissionsExt, symlink},
        process::CommandExt,
    },
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    time::{Duration, Instant},
};

const SESSION: &str = "10000000-0000-0000-0000-000000000001";
const ROOM: &str = "20000000-0000-0000-0000-000000000002";
const OTHER: &str = "20000000-0000-0000-0000-000000000003";
const SOURCE: &str = "30000000-0000-0000-0000-000000000003";
const REPLY: &str = "40000000-0000-0000-0000-000000000004";
const OLD: &str = "30000000-0000-0000-0000-000000000004";
const LATEST: &str = "30000000-0000-0000-0000-000000000005";
const CONFLICT: &str = "30000000-0000-0000-0000-000000000006";

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let mut bytes = [0; 12];
        getrandom::getrandom(&mut bytes).unwrap();
        let name: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        let root = env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("reverie-room-{name}"));
        fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
        let fixture = Self(root);
        fs::write(
            fixture.0.join("instance.json"),
            json!({
                "id": SESSION, "agent_name": "Test", "owner_name": "Owner",
                "data_dir": "memory", "persona": "Synthetic test agent",
            })
            .to_string(),
        )
        .unwrap();
        fixture.config(SESSION, 3.0);
        fixture.rooms(json!([member()]));
        fixture
    }
    fn settings(&self) -> PathBuf {
        self.0
            .join("relocated/hands")
            .join(SESSION)
            .join("agent.json")
    }
    fn config(&self, session: &str, timeout: f64) {
        let file = self.settings();
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(
            &file,
            json!({
                "self_session_id": session, "memory_instance": self.0.join("instance.json"),
                "memory_timeout_s": timeout,
                "cli": [env!("CARGO_BIN_EXE_reverie-room-fixture"), self.0.to_str().unwrap()],
            })
            .to_string(),
        )
        .unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
    }
    fn rooms(&self, rooms: Value) {
        fs::write(self.0.join("rooms.json"), rooms.to_string()).unwrap();
    }
    fn database(&self) -> PathBuf {
        self.0
            .join("memory/harness-room-memory-v1")
            .join(ROOM)
            .join("memory.sqlite")
    }
    fn store(&self) -> MemoryStore {
        MemoryStore::open(self.database()).unwrap()
    }
    fn automatic(&self, op: &str, fields: Value) -> Output {
        let mut config: Value =
            serde_json::from_slice(&fs::read(self.settings()).unwrap()).unwrap();
        config["recall_cap_chars"] = json!(3000);
        config["history_n"] = json!(30);
        config["message_cap_chars"] = json!(19);
        let mut job = json!({"config": config, "op": op, "room": ROOM});
        job.as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        let mut command = Command::new(env!("CARGO_BIN_EXE_reverie-admin-memory"));
        let mut child = command
            .env_clear()
            .arg(format!("--automatic-worker={}", std::process::id()))
            .process_group(0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(job.to_string().as_bytes())
            .unwrap();
        child.wait_with_output().unwrap()
    }
    fn history(&self, source: Value, reply: Value) {
        fs::write(
            self.0.join("history.json"),
            json!({"messages": [source, reply]}).to_string(),
        )
        .unwrap();
    }
    fn call(&self, room: &str, query: &str, bound: &str) -> Output {
        Command::new(env!("CARGO_BIN_EXE_reverie-admin-memory"))
            .env_clear()
            .env("HOME", self.0.join("stale"))
            .env("REVERIE_AGENT_HOME", self.0.join("stale"))
            .env("REVERIE_DATA_DIR", self.0.join("relocated"))
            .env("REVERIE_MUX", "1")
            .env("REVERIE_SESSION_ID", SESSION)
            .args(["--room", room, "--query", query, "--max-chars", bound])
            .output()
            .unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn member() -> Value {
    json!({"id": ROOM, "name": "project", "visibility": "private", "members": [SESSION]})
}

fn add(store: &MemoryStore, metadata: &Value, text: &str) {
    store
        .add_external_episode(
            metadata["source"].as_str().unwrap(),
            &format!("{metadata}\n{text}"),
            "compiler baseline passed",
            "room",
        )
        .unwrap();
}

fn accepted(output: &Output) -> Value {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());
    serde_json::from_slice(&output.stdout).unwrap()
}

fn refused(output: &Output) {
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    let error: Value = serde_json::from_slice(&output.stderr).unwrap();
    assert_eq!(error["error"], "ValueError");
    assert!(!String::from_utf8_lossy(&output.stderr).contains(ROOM));
}

#[test]
fn actual_cli_joins_old_room_rows_and_preserves_database_bytes() {
    let fixture = Fixture::new();
    let store = fixture.store();
    add(
        &store,
        &json!({"schema":1,"room":ROOM,"source":SOURCE,"at":10,"kind":"exchange","reply_id":REPLY}),
        "compiler baseline verified 😀",
    );
    for (id, at) in [(OLD, 10), (LATEST, 20), (CONFLICT, 20)] {
        add(
            &store,
            &json!({"schema":1,"room":ROOM,"source":id,"at":at,"kind":"fact","key":"build"}),
            "compiler baseline target",
        );
    }
    add(
        &store,
        &json!({"schema":1,"room":OTHER,"source":OTHER,"at":30,"kind":"fact","key":"build"}),
        "compiler baseline foreign",
    );
    store.close().unwrap();
    let db = fs::read(fixture.database()).unwrap();
    let result = accepted(&fixture.call("project", "compiler baseline", "3000"));
    let text = result["text"].as_str().unwrap();
    assert!(text.contains(r#"\ud83d\ude00"#));
    assert!(text.contains(REPLY));
    assert!(text.contains("\"unresolved_conflict\": true"));
    assert!(text.contains(&format!("[\"{LATEST}\", \"{CONFLICT}\"]")));
    assert!(!text.contains(OLD));
    assert!(!text.contains(OTHER));
    let sources = result["sourceMessageIds"].as_array().unwrap();
    assert_eq!(sources.len(), 3);
    assert!(sources.contains(&json!(SOURCE)));
    assert_eq!(result["roomId"], ROOM);
    assert_eq!(fs::read(fixture.database()).unwrap(), db);
    assert_eq!(fs::read_to_string(fixture.0.join("calls")).unwrap(), "4");
    let small = accepted(&fixture.call(ROOM, "compiler baseline", "55"));
    assert_eq!(small["text"], "");
    assert_eq!(small["sourceMessageIds"], json!([]));
}

#[test]
fn missing_ambiguous_direct_message_or_revoked_membership_withholds_output() {
    let fixture = Fixture::new();
    for rooms in [
        json!([]),
        json!([{"id": ROOM, "name": "project", "kind": "dm", "visibility": "private", "members": [SESSION]}]),
        json!([member(), {"id": OTHER, "name": "project", "visibility": "public", "members": [SESSION]}]),
    ] {
        fixture.rooms(rooms);
        refused(&fixture.call("project", "compiler baseline", "3000"));
    }
    fixture.rooms(json!([member()]));
    let store = fixture.store();
    add(
        &store,
        &json!({"schema":1,"room":ROOM,"source":SOURCE,"at":10,"kind":"exchange","reply_id":REPLY}),
        "compiler baseline verified",
    );
    store.close().unwrap();
    let before = fs::read(fixture.database()).unwrap();
    fs::write(fixture.0.join("mode"), "revoked").unwrap();
    fs::write(fixture.0.join("calls"), "0").unwrap();
    refused(&fixture.call(ROOM, "compiler baseline", "3000"));
    assert_eq!(fs::read_to_string(fixture.0.join("calls")).unwrap(), "4");
    assert_eq!(fs::read(fixture.database()).unwrap(), before);
}

#[test]
fn retains_selected_private_configuration_and_refuses_symlinked_database() {
    let fixture = Fixture::new();
    let good = fixture.settings();
    let ordinary = accepted(&fixture.call(ROOM, "compiler", "3000"));
    assert_eq!(ordinary["text"], "");
    assert!(!fixture.database().exists());
    fs::set_permissions(&good, fs::Permissions::from_mode(0o644)).unwrap();
    refused(&fixture.call(ROOM, "compiler", "3000"));
    fixture.config(OTHER, 3.0);
    refused(&fixture.call(ROOM, "compiler", "3000"));
    fixture.config(SESSION, 3.0);
    let db = fixture.database();
    fs::create_dir_all(db.parent().unwrap()).unwrap();
    symlink(Path::new("/unavailable/synthetic.sqlite"), db).unwrap();
    refused(&fixture.call(ROOM, "compiler", "3000"));
}

#[test]
fn nested_membership_deadline_and_output_overflow_fail_closed() {
    let fixture = Fixture::new();
    fixture.config(SESSION, 0.15);
    for mode in ["blocked", "overflow"] {
        fs::write(fixture.0.join("mode"), mode).unwrap();
        let started = Instant::now();
        refused(&fixture.call(ROOM, "compiler", "3000"));
        assert!(started.elapsed() < Duration::from_secs(3));
    }
    refused(&fixture.call(ROOM, "", "3000"));
    refused(&fixture.call(ROOM, "compiler", "12001"));
}

fn readback() -> (Value, Value, Value) {
    let source = json!({
        "id": SOURCE, "roomId": ROOM, "at": 12, "text": "compiler baseline 😀 and follow-up",
        "phoneWake": true,
    });
    let reply = json!({
        "id": REPLY, "roomId": ROOM, "text": "confirmed answer", "phoneWake": false,
        "from": {"sessionId": SESSION},
    });
    let job = json!({"event": {
        "source": SOURCE, "at": 12.0, "text": "compiler baseline 😀",
        "reply": "confirmed answer", "reply_id": REPLY,
    }});
    (source, reply, job)
}

#[test]
fn automatic_reuses_manual_evidence_and_preserves_confirmed_exchange_identity() {
    let fixture = Fixture::new();
    let (source, reply, job) = readback();
    fixture.history(source, reply);
    let original = accepted(&fixture.automatic("record", job.clone()));
    assert_eq!(accepted(&fixture.automatic("record", job)), original);
    let store = fixture.store();
    let id = original["id"].as_i64().unwrap();
    let row = store.get(id).unwrap();
    assert_eq!(store.count(None).unwrap(), 1);
    assert!(row.last_accessed.is_none());
    assert_eq!(
        row.user_text,
        format!(
            "{{\"at\": 12.0, \"kind\": \"exchange\", \"reply_id\": \"{REPLY}\", \"room\": \"{ROOM}\", \"schema\": 1, \"source\": \"{SOURCE}\"}}\ncompiler baseline 😀"
        )
    );
    add(
        &store,
        &json!({"schema":1,"room":ROOM,"source":OLD,"at":10,"kind":"exchange"}),
        "compiler baseline legacy question",
    );
    store.close().unwrap();

    let manual = accepted(&fixture.call(ROOM, "compiler baseline", "3000"));
    let automatic = accepted(&fixture.automatic("recall", json!({"query": "compiler baseline"})));
    assert_eq!(automatic["text"], manual["text"]);
    assert_eq!(automatic["sources"], manual["sourceMessageIds"]);
    assert!(
        automatic["text"]
            .as_str()
            .unwrap()
            .contains("\"confirmed_reply_id\": null")
    );
    let store = fixture.store();
    assert!(store.get(id).unwrap().last_accessed.is_some());
    store.close().unwrap();
    assert_eq!(
        fs::metadata(fixture.database())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
}

#[test]
fn automatic_refuses_unverified_history_and_removal_before_writing() {
    let fixture = Fixture::new();
    let (source, reply, job) = readback();
    for (key, value) in [
        ("phoneWake", json!(null)),
        ("at", json!(13)),
        ("roomId", json!(OTHER)),
    ] {
        let mut changed = source.clone();
        changed[key] = value;
        fixture.history(changed, reply.clone());
        automatic_refused(&fixture.automatic("record", job.clone()));
        assert!(!fixture.database().exists());
    }
    let mut wrong_author = reply.clone();
    wrong_author["from"]["sessionId"] = json!(OTHER);
    fixture.history(source.clone(), wrong_author);
    automatic_refused(&fixture.automatic("record", job.clone()));
    assert!(!fixture.database().exists());

    fixture.history(source, reply);
    fs::write(fixture.0.join("mode"), "record-revoked").unwrap();
    automatic_refused(&fixture.automatic("record", job));
    let store = fixture.store();
    assert_eq!(store.count(None).unwrap(), 0);
    store.close().unwrap();
}

fn automatic_refused(output: &Output) {
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert!(output.stderr.is_empty());
}
