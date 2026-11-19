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
const SOURCE: &str = "message-source";

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
            &json!([{"id":ROOM,"name":"Office","lastMessage":{"id":SOURCE}}]),
        );
        self.write("receipt.json", &json!({"message":{"id":"posted"}}));
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

fn job(path: &Path) -> Value {
    json!({
        "office":{"cli":[env!("CARGO_BIN_EXE_reverie-room-fixture"),path],"timeout_s":3},
        "state":{"_auto_rooms":[ROOM],ROOM:{"since":1,"seen":[],"claims":{},"last_id":"previous"}},
        "path":path.join("state.json"),
        "settings":{"rooms":null,"dm_rooms":[],"name":"Hands","session":"agent","max_rooms":4,
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

fn run(fixture: &Fixture, change: DuringAnswer) -> (u64, usize) {
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
    writeln!(channel.get_mut(), "{}", job(&fixture.0)).unwrap();
    let mut recorded = 0;
    let posted = loop {
        let mut line = String::new();
        assert_ne!(channel.read_line(&mut line).unwrap(), 0);
        let event: Value = serde_json::from_str(&line).unwrap();
        match event["effect"].as_str() {
            Some("answer") => answer(channel.get_mut(), fixture, &change),
            Some("record") => {
                assert_eq!(event["event"]["reply"], "café");
                assert_eq!(event["event"]["reply_id"], "posted");
                recorded += 1;
                writeln!(channel.get_mut(), "{{}}").unwrap();
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
        let (posted, recorded) = run(&fixture, change);
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
