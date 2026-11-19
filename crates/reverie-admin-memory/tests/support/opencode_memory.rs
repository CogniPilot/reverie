use super::{Fixture, data, reply, seed_earlier_ballot};
use reverie_application::project_memory::ProjectMemory;
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{fs, os::unix::fs::PermissionsExt, path::Path};

#[test]
fn native_recall_keeps_project_and_private_history_separate() {
    let fixture = Fixture::new();
    let instance = fixture.instance();
    let request = json!({"action":"recall","query":"parity","channel":"work"});
    let refused = fixture.bridge(&instance, request.clone());
    assert!(!refused.status.success());
    assert!(String::from_utf8_lossy(&refused.stderr).contains("private recall is unavailable"));
    let state = fixture.0.join("state");
    assert!(!state.exists());
    let mut scoped = request;
    scoped["project"] = json!("compiler");
    assert_eq!(reply(fixture.bridge(&instance, scoped.clone())), json!([]));
    assert_eq!(
        fs::metadata(&state).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert!(!state.join("memory.sqlite").exists());
    reply(fixture.bridge(
        &instance,
        json!({
            "action":"record","source_id":"opencode:private:fixture",
            "user":"Private parity result","reply":"Do not share this."
        }),
    ));
    let project = ProjectMemory::open(state.join("projects"), "compiler").unwrap();
    project
        .remember("Public parity result", "Verified fixture")
        .unwrap();
    project.close().unwrap();
    let result = reply(fixture.bridge(&instance, scoped.clone()));
    assert_eq!(result.as_array().unwrap().len(), 1);
    assert_eq!(result[0]["text"], "Public parity result");
    let fallback = reply(fixture.bridge_with(&instance, scoped, |command| {
        command.env("REVERIE_SESSION_ID", "fixture");
        command.env("PATH", fixture.0.join("empty-path"));
    }));
    assert_eq!(fallback["legacy"][0]["id"], result[0]["id"]);
    assert_eq!(fallback["legacy"][0]["text"], result[0]["text"]);
    assert_eq!(fallback["journal"], json!([]));
    assert!(
        fallback["note"]
            .as_str()
            .unwrap()
            .contains("client is unavailable")
    );
    let own = reply(fixture.bridge(
        &instance,
        json!({"action":"recall","query":"parity","channel":"private"}),
    ));
    assert_eq!(own.as_array().unwrap().len(), 1);
    assert_eq!(own[0]["user_text"], "Private parity result");
}

#[test]
fn native_vacation_publishes_one_verified_archive_after_three_ballots() {
    let fixture = Fixture::new();
    let instance = fixture.instance();
    let state = fixture.0.join("state");
    let request =
        || json!({"action":"vacation","reason":"Rest","handoff":"Keep the current plan."});
    let mode = || reply(fixture.bridge(&instance, json!({"action":"mode"})));
    let first = reply(fixture.bridge(&instance, request()));
    assert_eq!(first["ballot"]["consecutive_weeks"], 1);
    assert_eq!(mode()["mode"], "active");
    assert!(!state.join("archives").exists());
    reply(fixture.bridge(
        &instance,
        json!({
            "action":"record","source_id":"opencode:fixture:archive",
            "user":"A project fact", "reply":"Verified"
        }),
    ));
    reply(fixture.bridge(
        &instance,
        json!({"action":"plan","revision":0,"text":"Keep the compiler plan."}),
    ));
    for weeks in [1, 2] {
        seed_earlier_ballot(&state.join("memory.sqlite"), "vacation", weeks);
    }
    let archives = state.join("archives");
    fs::write(&archives, b"wrong filesystem type").unwrap();
    assert!(!fixture.bridge(&instance, request()).status.success());
    assert_eq!(mode()["mode"], "active");
    fs::remove_file(&archives).unwrap();
    let approved = reply(fixture.bridge(&instance, request()));
    assert_eq!(mode()["mode"], "vacation");
    let record = &approved["body"];
    let archive = Path::new(record["archive"].as_str().unwrap());
    verify_archive(archive, record);
    assert_eq!(reply(fixture.bridge(&instance, request())), approved);
    assert_eq!(fs::read_dir(&archives).unwrap().count(), 1);
    let resumed = reply(fixture.bridge(&instance, json!({"action":"return"})));
    assert_eq!(resumed["body"]["needs_handoff"], true);
    assert!(archive.join("memory.sqlite").exists());
}

fn verify_archive(archive: &Path, record: &Value) {
    let snapshot = archive.join("memory.sqlite");
    let handoff = archive.join("handoff.json");
    assert_eq!(data(&handoff), *record);
    let digest = Sha256::digest(fs::read(&snapshot).unwrap());
    assert_eq!(record["database_sha256"], format!("{digest:x}"));
    for path in [&snapshot, &handoff] {
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o444
        );
    }
    let db = Connection::open_with_flags(snapshot, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let count: i64 = db
        .query_row("SELECT count(*) FROM memories", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 1);
    let plan: String = db
        .query_row(
            "SELECT body FROM reverie_documents WHERE name='plan'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&plan).unwrap(),
        "Keep the compiler plan."
    );
    let integrity: String = db
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .unwrap();
    assert_eq!(integrity, "ok");
}
