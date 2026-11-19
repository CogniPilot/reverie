use super::{Fixture, ROOM, SESSION, SOURCE, source};
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    os::{
        fd::OwnedFd,
        unix::{net::UnixStream, process::CommandExt},
    },
    process::{Command, Stdio},
    time::Duration,
};

fn check(fixture: &Fixture, mut fresh: Value) -> Value {
    let mut original = source(true);
    original["from"] =
        json!({"kind":"user","name":"Owner","mark":"owner_typed","authenticatedOwner":true});
    fresh["text"] = original["text"].clone();
    fresh["from"]["name"] = json!("Owner");
    fresh["from"]["mark"] = json!("owner_typed");
    fixture.write("messages.json", &json!({SOURCE:fresh}));
    let config = json!({
        "root":fixture.0.join("work"),"tool_schema_file":fixture.0.join("tools.json"),
        "runner_argv":["/unused-runner"],"profiles":{"drill":{}},
        "tasks":{"inspect":{"rooms":[ROOM],"delegate_sessions":[]}},
    });
    fixture.write("agent.json", &json!({"coding":config}));
    fixture.write(
        "alert.json",
        &json!({"members":[{"sessionId":SESSION,"name":"Hands","alertMode":null}]}),
    );
    let job = json!({
        "office":{"cli":[env!("CARGO_BIN_EXE_reverie-room-fixture"),fixture.0],"timeout_s":0.75},
        "request":{"config_path":fixture.0.join("agent.json"),"settings":config,
            "room":ROOM,"session":SESSION,"task":"inspect","message":original,"history_n":10,
            "expired":false,"check_cancel":true}
    });
    let (reader, writer) = UnixStream::pair().unwrap();
    reader
        .set_read_timeout(Some(Duration::from_secs(6)))
        .unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_reverie-admin-memory"))
        .arg(format!(
            "--hands-coding-authorization-worker={}",
            std::process::id()
        ))
        .process_group(0)
        .stdin(Stdio::from(OwnedFd::from(writer)))
        .spawn()
        .unwrap();
    let mut stream = BufReader::new(reader);
    writeln!(stream.get_mut(), "{job}").unwrap();
    let mut reply = String::new();
    assert_ne!(stream.read_line(&mut reply).unwrap(), 0);
    assert!(child.wait().unwrap().success());
    serde_json::from_str(&reply).unwrap()
}

#[test]
fn native_coding_authorization_requires_the_current_owner_and_phone_acceptance() {
    let fixture = Fixture::new();
    let mut fresh = source(true);
    fresh["from"]["authenticatedOwner"] = json!(true);
    assert_eq!(check(&fixture, fresh.clone()), json!({"denial":null}));
    fresh["from"]["authenticatedOwner"] = json!(false);
    assert_eq!(check(&fixture, fresh.clone()), json!({"denial":"revoked"}));
    fresh["from"]["authenticatedOwner"] = json!(true);
    fresh["phoneWake"] = json!(false);
    assert_eq!(check(&fixture, fresh), json!({"denial":"silent"}));
}
