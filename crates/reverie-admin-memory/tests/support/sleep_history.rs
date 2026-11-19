use super::{EMPLOYEE, Fixture, OTHER, success, write};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::fs;

fn message(id: &str, at: i64, session: Option<&str>, text: &str) -> Value {
    let from = session.map_or_else(
        || json!({"kind":"user"}),
        |session| json!({"kind":"agent","sessionId":session,"name":"Member"}),
    );
    json!({"id":id,"at":at,"from":from,"text":text})
}

fn room(name: &str, session: &str, messages: Vec<Value>) -> Value {
    json!({"name":name,"members":[{"sessionId":session}],"messages":messages})
}

fn load_db(fixture: &Fixture, rooms: Vec<Value>) {
    let db = Connection::open(fixture.0.join("chat.db")).unwrap();
    db.execute_batch("CREATE TABLE rooms(id TEXT PRIMARY KEY,data TEXT NOT NULL);
        CREATE TABLE messages(room_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(room_id,id));").unwrap();
    for (id, mut room) in rooms.into_iter().enumerate() {
        let id = id.to_string();
        let messages = room.as_object_mut().unwrap().remove("messages").unwrap();
        db.execute(
            "INSERT INTO rooms VALUES (?,?)",
            params![id, room.to_string()],
        )
        .unwrap();
        for message in messages.as_array().unwrap() {
            db.execute(
                "INSERT INTO messages VALUES (?,?,?,?)",
                params![
                    id,
                    message["id"].as_str().unwrap(),
                    message["at"].as_i64().unwrap(),
                    message.to_string()
                ],
            )
            .unwrap();
        }
    }
}

#[test]
fn sqlite_import_observes_only_member_rooms_and_keeps_a_retry_safe_cursor() {
    let fixture = Fixture::new();
    let expert = fixture.agent("expert", None, true);
    let mut private = room(
        "A private DM",
        "S1",
        vec![message("dm", 44, Some("S1"), "private detail")],
    );
    private["dm"] = json!({"sessionId":"S1"});
    let mut deleted = message("gone", 43, Some("S1"), "deleted body");
    deleted["deleted"] = json!({"at":44,"by":"owner"});
    load_db(
        &fixture,
        vec![
            room(
                "compiler",
                "S1",
                vec![
                    message("ask", 32, None, "How is the compiler?"),
                    message("contact", 33, Some("S2"), "Call Jane Roe at 555-123-4567"),
                    message("good", 39, Some("S1"), "The compiler passed."),
                    message("floor", 40, Some("S1"), "Call Jane Roe at 555-123-4567"),
                    deleted,
                ],
            ),
            private,
            room(
                "other team",
                "S2",
                vec![message("other", 45, Some("S1"), "unjoined room")],
            ),
        ],
    );
    let mut policy = fixture.policy(&[expert]);
    policy.as_object_mut().unwrap().remove("chatrooms");
    policy["chat_db"] = json!(fixture.0.join("chat.db"));
    let store = fixture.store("expert");
    store.set_state("sleep_consolidated_ms", "35").unwrap();
    store.set_state("reverie_last_activity", "500").unwrap();
    store.close().unwrap();
    let database = fs::read(fixture.0.join("chat.db")).unwrap();
    let first = fixture.tick(&policy);
    assert!(first.contains("consolidated expert 1 live"), "{first}");
    assert!(first.contains("skipped expert 0 live"));
    assert!(fixture.tick(&policy).contains("consolidated expert 0 live"));
    assert_eq!(fs::read(fixture.0.join("chat.db")).unwrap(), database);
    let store = fixture.store("expert");
    let episodes = store.all(Some("episode")).unwrap();
    assert_eq!(episodes.len(), 1);
    assert_eq!(
        episodes[0].user_text,
        "[compiler]\nOwner: How is the compiler?"
    );
    assert_eq!(episodes[0].assistant_text, "The compiler passed.");
    assert_eq!(
        store
            .get_state("sleep_consolidated_ms", None)
            .unwrap()
            .as_deref(),
        Some("40")
    );
    assert_eq!(
        store
            .get_state("reverie_last_activity", None)
            .unwrap()
            .as_deref(),
        Some("500")
    );
    store.close().unwrap();
}

#[test]
fn dry_run_counts_all_and_live_batch_keeps_identical_timestamps_together() {
    let fixture = Fixture::new();
    let expert = fixture.agent("expert", None, true);
    let mut policy = fixture.policy(&[expert]);
    let posts = (1..=203)
        .map(|i| {
            let at = if (200..=202).contains(&i) { 200 } else { i };
            message(&i.to_string(), at, Some("S1"), "A test passed.")
        })
        .collect();
    write(
        &fixture.0.join("chat.json"),
        &json!([room("compiler", "S1", posts)]),
    );
    policy["dry_run"] = json!(true);
    assert!(
        fixture
            .tick(&policy)
            .contains("would_consolidate expert 203 dry-run")
    );
    assert!(!fixture.0.join("expert/memory.sqlite").exists());
    policy["dry_run"] = json!(false);
    assert!(
        fixture
            .tick(&policy)
            .contains("consolidated expert 202 live")
    );
    assert!(fixture.tick(&policy).contains("consolidated expert 1 live"));
    assert!(fixture.tick(&policy).contains("consolidated expert 0 live"));
    let store = fixture.store("expert");
    assert_eq!(store.count(Some("episode")).unwrap(), 203);
    store.close().unwrap();
}

#[test]
fn company_session_moves_preserve_seen_ids_and_refuse_other_employees() {
    let fixture = Fixture::new();
    let mut expert = fixture.agent("expert", Some(EMPLOYEE), true);
    expert["employee_id"] = json!(EMPLOYEE);
    expert.as_object_mut().unwrap().remove("session_id");
    let mut wrong = fixture.agent("mismatch", Some(EMPLOYEE), false);
    wrong["employee_id"] = json!(OTHER);
    let mut policy = fixture.policy(&[expert, wrong]);
    let company = fixture.0.join("company.json");
    policy["company"] = json!(company);
    write(
        &company,
        &json!({"employees":[{"id":EMPLOYEE,"sessionId":"OLD"}]}),
    );
    let check = fixture.run("check-policy", &policy, |_| ());
    assert_eq!(check.status.code(), Some(1));
    assert!(
        String::from_utf8_lossy(&check.stdout)
            .contains(&format!("unknown_employee mismatch {OTHER}"))
    );
    let ledger = fixture.0.join("policy-state/sleep-expert.sessions.json");
    assert!(!ledger.exists());
    assert!(
        fixture
            .tick(&policy)
            .contains("unknown_employee mismatch 0 live")
    );
    write(
        &company,
        &json!({"employees":[{"id":EMPLOYEE,"sessionId":"S1"},{"id":OTHER,"sessionId":"S2"}]}),
    );
    write(
        &fixture.0.join("chat.json"),
        &json!([room(
            "retained room",
            "OLD",
            vec![
                message("old", 42, Some("OLD"), "Earlier session"),
                message("new", 43, Some("S1"), "Replacement session"),
            ]
        ),]),
    );
    let output = fixture.tick(&policy);
    assert!(output.contains("consolidated expert 2 live"));
    assert!(output.contains("refused_employee_mismatch mismatch 0 live"));
    let seen: Value = serde_json::from_slice(&fs::read(ledger).unwrap()).unwrap();
    assert_eq!(seen, json!(["OLD", "S1"]));
    assert!(!fixture.0.join("mismatch").exists());
    assert!(
        !fixture
            .0
            .join("policy-state/sleep-mismatch.sessions.json")
            .exists()
    );
}

#[test]
fn remote_endpoints_are_refused_before_opening_even_during_dry_run() {
    let fixture = Fixture::new();
    let expert = fixture.agent("expert", None, false);
    let mut policy = fixture.policy(&[expert]);
    for dry in [false, true] {
        policy["dry_run"] = json!(dry);
        for setting in ["REVERIE_API_BASE", "REVERIE_EMBED_URL"] {
            let run = success(fixture.run("tick", &policy, |command| {
                command.env(setting, "https://hosted.example.test/v1");
            }));
            assert!(run.contains("refused_remote_model expert 0"), "{run}");
            assert!(!fixture.0.join("expert").exists());
        }
    }
}

#[test]
fn backfill_and_a_failed_agent_leave_other_agents_eligible() {
    let fixture = Fixture::new();
    let mut broken = fixture.agent("broken", None, false);
    broken["instance"] = json!(fixture.0.join("missing.json"));
    let expert = fixture.agent("expert", None, true);
    let mut policy = fixture.policy(&[broken, expert]);
    policy["backfill_days"] = json!(1);
    let now = jiff::Timestamp::now().as_millisecond();
    write(
        &fixture.0.join("chat.json"),
        &json!([room(
            "compiler",
            "S1",
            vec![
                message("old", now - 172_800_000, Some("S1"), "Old reply"),
                message("new", now - 60_000, Some("S1"), "Recent reply"),
            ]
        )]),
    );
    let output = fixture.tick(&policy);
    assert!(
        output.contains("error_") && output.contains("broken 0 live"),
        "{output}"
    );
    assert!(output.contains("consolidated expert 1 live"));
    let store = fixture.store("expert");
    let episodes = store.all(Some("episode")).unwrap();
    assert_eq!(episodes[0].assistant_text, "Recent reply");
    store.close().unwrap();
}
