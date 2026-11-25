#![cfg(feature = "test-fixtures")]

use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::{
        fd::OwnedFd,
        unix::{net::UnixStream, process::CommandExt},
    },
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};

const ROOM: &str = "40000000-0000-4000-8000-000000000001";
const SOURCE: &str = "30000000-0000-4000-8000-000000000002";
const REPLY: &str = "30000000-0000-4000-8000-000000000003";
const SESSION: &str = "20000000-0000-4000-8000-000000000004";

#[path = "support/hands_authorization.rs"]
mod authorization;
#[path = "support/hands_supervisor.rs"]
mod supervisor;

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let path = nix::unistd::mkdtemp(&std::env::temp_dir().join("hands-tick-XXXXXX")).unwrap();
        let fixture = Self(path);
        fixture.prepare();
        fixture
    }

    fn prepare(&self) {
        let message = source(true);
        self.write(
            "history.json",
            &json!({"messages":[message],"timeZone":"UTC"}),
        );
        self.write("messages.json", &json!({SOURCE:message}));
        self.write(
            "rooms.json",
            &json!([{"id":ROOM,"name":"Office","visibility":"private","members":[SESSION],
                     "lastMessage":{"id":SOURCE}}]),
        );
        self.write("receipt.json", &json!({"message":{"id":REPLY}}));
    }

    fn write(&self, name: &str, value: &Value) {
        fs::write(self.0.join(name), value.to_string()).unwrap();
    }

    fn saved(&self) -> Value {
        serde_json::from_slice(&fs::read(self.0.join("state.json")).unwrap()).unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn source(phone_wake: bool) -> Value {
    json!({"id":SOURCE,"at":10,"roomId":ROOM,"from":{"kind":"user"},"text":"hello","phoneWake":phone_wake})
}

enum DuringAnswer {
    Available,
    PhoneMuted,
    Removed,
}

fn job(path: &Path, memory: Value) -> Value {
    json!({
        "office":{"cli":[env!("CARGO_BIN_EXE_reverie-room-fixture"),path],"timeout_s":3},
        "memory":memory,
        "state":{"_auto_rooms":[ROOM],ROOM:{"since":1,"seen":[],"claims":{},"last_id":"previous"}},
        "path":path.join("state.json"),
        "settings":{"rooms":null,"dm_rooms":[],"name":"Hands","session":SESSION,"max_rooms":4,
                    "history_n":10,"max_answers":1,"reply_chars":4,"message_chars":10},
    })
}

fn answer(channel: &mut UnixStream, fixture: &Fixture, change: &DuringAnswer) {
    assert_eq!(fixture.saved()[ROOM]["claims"][SOURCE]["tries"], 1);
    match change {
        DuringAnswer::Available => {}
        DuringAnswer::PhoneMuted => fixture.write("messages.json", &json!({SOURCE:source(false)})),
        DuringAnswer::Removed => fixture.write("rooms.json", &json!([])),
    }
    // The pre-existing coding queue orders receipts by insertion. Preserve its
    // original order even when a room claim writes the complete file again.
    let reply = r#"{"reply":"café extra","characters":12,"searches":0,"timing":"-","coding":{"_coding":{"z":1,"a":2},"_coding_epoch":7}}"#;
    writeln!(channel, "{reply}").unwrap();
}

fn run(fixture: &Fixture, change: DuringAnswer, memory: Value) -> (u64, usize) {
    let (reader, writer) = UnixStream::pair().unwrap();
    reader
        .set_read_timeout(Some(Duration::from_secs(8)))
        .unwrap();
    let mut worker = Command::new(env!("CARGO_BIN_EXE_reverie-admin-memory"))
        .arg(format!("--hands-tick-worker={}", std::process::id()))
        .process_group(0)
        .stdin(Stdio::from(OwnedFd::from(writer)))
        .spawn()
        .unwrap();
    let mut channel = BufReader::new(reader);
    writeln!(channel.get_mut(), "{}", job(&fixture.0, memory)).unwrap();
    let mut recorded = 0;
    let posted = loop {
        let mut line = String::new();
        assert_ne!(channel.read_line(&mut line).unwrap(), 0);
        let event: Value = serde_json::from_str(&line).unwrap();
        match event["effect"].as_str() {
            Some("answer") => answer(channel.get_mut(), fixture, &change),
            Some("memory") => {
                let request = &event["request"];
                match request["op"].as_str() {
                    Some("record") => {
                        assert_eq!(request["event"]["reply"], "café");
                        assert_eq!(request["event"]["reply_id"], REPLY);
                        recorded += 1;
                    }
                    Some("recall") => assert_eq!(request["query"], "hello"),
                    other => panic!("unexpected memory request {other:?}"),
                }
                writeln!(channel.get_mut(), "null").unwrap();
            }
            None if event["posted"].is_u64() => break event["posted"].as_u64().unwrap(),
            None => assert!(event["error"].is_null(), "{event}"),
            Some(other) => panic!("unexpected compatibility callback {other}"),
        }
    };
    assert!(worker.wait().unwrap().success());
    (posted, recorded)
}

#[test]
fn native_poll_publishes_claim_before_model_and_records_only_authorized_posts() {
    for (change, expected) in [
        (DuringAnswer::Available, 1),
        (DuringAnswer::PhoneMuted, 0),
        (DuringAnswer::Removed, 0),
    ] {
        let fixture = Fixture::new();
        let (posted, recorded) = run(&fixture, change, json!({"mode":"external"}));
        assert_eq!(posted, expected);
        assert_eq!(recorded as u64, expected);
        assert_eq!(fixture.0.join("post.json").exists(), expected == 1);
        let saved = fixture.saved();
        assert_eq!(saved[ROOM]["claims"], json!({}));
        assert_eq!(saved[ROOM]["seen"], json!([SOURCE]));
        assert_eq!(saved["_coding_epoch"], 7);
        let bytes = fs::read_to_string(fixture.0.join("state.json")).unwrap();
        assert!(bytes.contains(r#""_coding":{"z":1,"a":2}"#));
    }
}

#[test]
fn native_poll_keeps_memory_of_a_direct_conversation() {
    let fixture = Fixture::new();
    fixture.write(
        "rooms.json",
        &json!([{"id":ROOM,"name":"","kind":"dm","dm":[SESSION,"user"],"visibility":"private",
                 "members":[{"sessionId":SESSION}],"lastMessage":{"id":SOURCE}}]),
    );
    let (posted, recorded) = run(
        &fixture,
        DuringAnswer::Available,
        json!({"mode":"external"}),
    );
    assert_eq!((posted, recorded), (1, 1));
}

#[test]
fn native_poll_records_verified_reply_without_a_memory_callback() {
    let fixture = Fixture::new();
    fixture.write("instance.json", &json!({
        "id":SESSION,"agent_name":"Hands","owner_name":"Owner","data_dir":"memory","persona":"Synthetic only",
    }));
    fixture.write(
        "history-after.json",
        &json!({"messages":[source(true),{
            "id":REPLY,"roomId":ROOM,"from":{"sessionId":SESSION},"text":"café","phoneWake":false,
        }]}),
    );
    let memory = json!({"mode":"native","timeout_s":3,"recall_chars":3000,"config":{
        "cli":[env!("CARGO_BIN_EXE_reverie-room-fixture"),fixture.0],"memory_instance":fixture.0.join("instance.json"),
        "memory_timeout_s":3,"self_session_id":SESSION,"recall_cap_chars":3000,"history_n":10,"message_cap_chars":10,
    }});
    assert_eq!(run(&fixture, DuringAnswer::Available, memory), (1, 0));
    let path = fixture
        .0
        .join("memory/harness-room-memory-v1")
        .join(ROOM)
        .join("memory.sqlite");
    let store = reverie_store::memory::MemoryStore::open(path).unwrap();
    assert_eq!(store.count(None).unwrap(), 1);
    let row = store.get(1).unwrap();
    assert!(row.user_text.ends_with("\nhello"));
    assert_eq!(row.assistant_text, "café");
    store.close().unwrap();
}
