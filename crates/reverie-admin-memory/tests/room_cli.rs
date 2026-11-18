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

#[path = "support/journal_projection.rs"]
mod journal_projection;
#[path = "support/journal_write.rs"]
mod journal_write;

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
        config["journal_enabled"] = json!(true);
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
    fs::write(fixture.0.join("mode"), "second-membership-revoked").unwrap();
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

const CAPTURE_DIGEST: &str = "a2e6c4e66a925a2c2e0e5bf2861fc91e436cd0ff9bda1f5c033787b09779663f";
const SOURCE_DIGEST: &str = "e1e721e80a05aa5f97e6ee027e7815965d265c487e962ce239ceb6bfea8aeccc";
const RECEIPT_DIGEST: &str = "f902d20a8dbff7740ee3b8bd624e6af0c03b841aab1063e5504d4ff69b9b8566";

fn journal_source() -> (Value, Value) {
    // Produced by the Python journal's revision function over these messages.
    let mut messages = json!({});
    messages[REPLY] = json!({
        "id": REPLY, "roomId": ROOM, "at": 12.0,
        "text": "Capture a source 🐦", "from": null, "phoneWake": true,
    });
    messages[SOURCE] = json!({
        "id": SOURCE, "roomId": ROOM, "at": 1e-5, "text": "界".repeat(400),
        "from": {"display": "Día 🐦", "meta": {"𐐀": 1.0, "\u{e000}": 2}},
        "phoneWake": false,
    });
    let job = json!({"message_id": SOURCE,
        "captured_end": {"id": REPLY, "at": 12.0, "sha256": CAPTURE_DIGEST}});
    (messages, job)
}

fn set_messages(fixture: &Fixture, messages: &Value) {
    fs::write(fixture.0.join("messages.json"), messages.to_string()).unwrap();
}

#[test]
fn native_journal_source_reuses_legacy_digest_and_bounds_excerpt() {
    let fixture = Fixture::new();
    let (messages, job) = journal_source();
    set_messages(&fixture, &messages);
    let read = accepted(&fixture.automatic("journal_source", job));
    assert_eq!(read["status"], "available");
    assert_eq!(read["text"], "界".repeat(341));
    assert_eq!(read["truncated"], true);
    assert_eq!(
        read["revision"],
        json!({"id": SOURCE, "at": 1e-5, "sha256": SOURCE_DIGEST})
    );
    assert_eq!(fs::read_to_string(fixture.0.join("calls")).unwrap(), "2");
    assert!(!fixture.database().exists());
}

#[test]
fn native_journal_source_refuses_missing_or_changed_evidence_and_revocation() {
    let fixture = Fixture::new();
    let (messages, job) = journal_source();
    for (id, key, value) in [
        (REPLY, "text", json!("Edited request")),
        (REPLY, "from", json!({"display": "Edited sender"})),
        (SOURCE, "at", json!(13)),
        (SOURCE, "roomId", json!(OTHER)),
        (SOURCE, "phoneWake", Value::Null),
    ] {
        let mut changed = messages.clone();
        changed[id][key] = value;
        set_messages(&fixture, &changed);
        automatic_refused(&fixture.automatic("journal_source", job.clone()));
    }
    set_messages(&fixture, &json!({}));
    automatic_refused(&fixture.automatic("journal_source", job.clone()));

    for rooms in [
        json!([]),
        json!([{"id": ROOM, "kind": "dm", "visibility": "private", "members": [SESSION]}]),
    ] {
        fixture.rooms(rooms);
        automatic_refused(&fixture.automatic("journal_source", job.clone()));
    }
    fixture.rooms(json!([member()]));
    set_messages(&fixture, &messages);
    fs::write(fixture.0.join("calls"), "0").unwrap();
    fs::write(fixture.0.join("mode"), "second-membership-revoked").unwrap();
    automatic_refused(&fixture.automatic("journal_source", job));
    assert_eq!(fs::read_to_string(fixture.0.join("calls")).unwrap(), "2");
    assert!(!fixture.database().exists());
}

fn original_receipt(fixture: &Fixture) {
    let db = fixture.database();
    fs::create_dir_all(db.parent().unwrap()).unwrap();
    let connection = rusqlite::Connection::open(db).unwrap();
    connection.execute_batch(
        "CREATE TABLE hands_journal (id INTEGER PRIMARY KEY, turn_id TEXT UNIQUE NOT NULL,
             committed_ms REAL NOT NULL, payload_hash TEXT NOT NULL, payload TEXT NOT NULL, end_at REAL NOT NULL);"
    ).unwrap();
    connection
        .execute(
            "INSERT INTO hands_journal VALUES (7, ?1, 200.5, ?2, ?3, 12.0)",
            (
                SOURCE,
                RECEIPT_DIGEST,
                r#"{"draft":{"text":"receipt must never expose this 🐦"},"schema":1}"#,
            ),
        )
        .unwrap();
    connection.close().unwrap();
}

#[test]
fn native_journal_receipt_checks_stored_digest_and_never_changes_database() {
    let fixture = Fixture::new();
    original_receipt(&fixture);
    let before = fs::read(fixture.database()).unwrap();
    let found = fixture.automatic(
        "journal_receipt",
        json!({"turn_id": SOURCE, "expected_hash": RECEIPT_DIGEST}),
    );
    assert_eq!(
        accepted(&found),
        accepted(&fixture.automatic("journal_receipt", json!({"turn_id": 7})))
    );
    let receipt = accepted(&found);
    assert_eq!(receipt["status"], "committed");
    assert_eq!(receipt["entry_id"], 7);
    assert_eq!(receipt["turn_id"], SOURCE);
    assert_eq!(receipt["committed_ms"], 200.5);
    assert_eq!(receipt["payload_sha256"], RECEIPT_DIGEST);
    assert!(receipt["evidence"].is_string());
    assert_eq!(receipt.as_object().unwrap().len(), 6);
    assert!(!String::from_utf8_lossy(&found.stdout).contains("must never expose"));
    assert_eq!(
        accepted(&fixture.automatic(
            "journal_receipt",
            json!({
                "turn_id": 7, "expected_hash": "0".repeat(64),
            })
        )),
        json!({"status": "conflict", "entry_id": 7})
    );
    assert_eq!(fs::read(fixture.database()).unwrap(), before);

    let connection = rusqlite::Connection::open(fixture.database()).unwrap();
    connection
        .execute("UPDATE hands_journal SET payload='corrupted'", [])
        .unwrap();
    connection.close().unwrap();
    let corrupt = accepted(&fixture.automatic("journal_receipt", json!({"turn_id": SOURCE})));
    assert_eq!(corrupt, json!({"status": "conflict", "turn_id": SOURCE}));
    let corrupt = accepted(&fixture.automatic("journal_receipt", json!({"turn_id": 7})));
    assert_eq!(corrupt, json!({"status": "conflict", "entry_id": 7}));
}

#[test]
fn native_journal_receipt_distinguishes_absence_from_corruption_or_lost_access() {
    let fixture = Fixture::new();
    let job = json!({"turn_id": SOURCE});
    let missing = accepted(&fixture.automatic("journal_receipt", job.clone()));
    assert_eq!(missing["status"], "not_found");
    assert!(missing["evidence"].as_str().unwrap().contains("not proof"));
    assert!(!fixture.database().exists());

    fixture.store().close().unwrap();
    assert_eq!(
        accepted(&fixture.automatic("journal_receipt", job.clone())),
        missing
    );
    for value in [
        json!(-1),
        json!(1_000_000_000),
        json!(true),
        json!(1.0),
        json!("arbitrary"),
    ] {
        automatic_refused(&fixture.automatic("journal_receipt", json!({"turn_id": value})));
    }
    automatic_refused(&fixture.automatic(
        "journal_receipt",
        json!({"turn_id": SOURCE, "expected_hash": "malformed"}),
    ));
    fs::write(fixture.0.join("calls"), "0").unwrap();
    fs::write(fixture.0.join("mode"), "second-membership-revoked").unwrap();
    automatic_refused(&fixture.automatic("journal_receipt", job));
}

#[test]
fn native_journal_receipt_reports_an_unknown_numeric_entry_without_proving_absence() {
    let fixture = Fixture::new();
    original_receipt(&fixture);
    let missing = accepted(&fixture.automatic("journal_receipt", json!({"turn_id": 9})));
    assert_eq!(missing["status"], "not_found");
    assert_eq!(missing["entry_id"], 9);
    assert!(missing["evidence"].as_str().unwrap().contains("not proof"));
}
