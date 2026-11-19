use super::{Fixture, ROOM, accepted, journal_write};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    os::{fd::OwnedFd, unix::net::UnixStream, unix::process::CommandExt},
    process::{Command, Stdio},
    time::Duration,
};

fn send(channel: &mut BufReader<UnixStream>, request: &Value) {
    let socket = channel.get_mut();
    serde_json::to_writer(&mut *socket, request).unwrap();
    socket.write_all(b"\n").unwrap();
}

fn frame(channel: &mut BufReader<UnixStream>) -> Value {
    let mut line = String::new();
    assert_ne!(channel.read_line(&mut line).unwrap(), 0);
    serde_json::from_str(&line).unwrap()
}

#[test]
fn runs_the_complete_journal_turn_with_native_office_and_sqlite_effects() {
    let fixture = Fixture::new();
    let legacy = journal_write::vectors();
    let payload = journal_write::job(&fixture, &legacy, 0);
    let turn_id = payload["captured"]["end"]["id"].as_str().unwrap();
    let history = legacy["messages"].as_array().unwrap();
    let waking = history
        .iter()
        .find(|message| message["id"] == turn_id)
        .unwrap();
    let (client, server) = UnixStream::pair().unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(15)))
        .unwrap();
    let mut channel = BufReader::new(client);
    let mut worker = Command::new(env!("CARGO_BIN_EXE_reverie-admin-memory"))
        .env_clear()
        .arg(format!("--journal-turn-worker={}", std::process::id()))
        .process_group(0)
        .stdin(Stdio::from(OwnedFd::from(server)))
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    send(
        &mut channel,
        &json!({
            "room":ROOM, "history":history, "message":waking, "clock_ms":1000,
            "automatic":false,
            "memory":{"config":fixture.automatic_settings(),"status_timeout_s":3,"command_timeout_s":8,"suppress":false},
        }),
    );
    let view = frame(&mut channel);
    assert!(view["context"].as_str().unwrap().contains("No journal yet"));
    assert_eq!(view["captured"]["end"]["id"], turn_id);

    let commit = json!({"action":"invoke","call":{"function":{
        "name":"journal_commit", "arguments":payload["draft"].to_string()
    }}});
    send(&mut channel, &commit);
    assert_eq!(frame(&mut channel), json!({"write_started":true}));
    let reply = frame(&mut channel);
    assert_eq!(reply["result"]["status"], "committed");
    let receipt = accepted(&fixture.automatic("journal_receipt", json!({"turn_id":turn_id})));
    assert_eq!(receipt["entry_id"], reply["result"]["entry_id"]);
    assert_eq!(
        receipt["payload_sha256"],
        legacy["cases"][0]["receipt"]["payload_sha256"]
    );
    drop(channel);
    assert!(worker.wait().unwrap().success());
}
