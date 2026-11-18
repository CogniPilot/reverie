use serde_json::json;
use std::{
    fs,
    path::PathBuf,
    process::{Command, Output},
    sync::atomic::{AtomicUsize, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "reverie-context-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        std::os::unix::fs::symlink(
            env!("CARGO_BIN_EXE_reverie-admin-memory"),
            root.join("reverie-context"),
        )
        .unwrap();
        fs::write(root.join("instance.json"), json!({
            "id": "fixture", "agent_name": "Synthetic identity", "owner_name": "Test owner", "data_dir": "state",
            "persona": "Be precise.", "shared_room_tone": "social",
            "initial_self": {"consciousness":"Synthetic perspective.","directives":["Check the source."]},
        }).to_string()).unwrap();
        Self(root)
    }

    fn run(&self, args: &[&str]) -> Output {
        Command::new(self.0.join("reverie-context"))
            .env_clear()
            .env("REVERIE_INSTANCE_CONFIG", self.0.join("instance.json"))
            .current_dir(&self.0)
            .args(args)
            .output()
            .unwrap()
    }

    fn text(&self, args: &[&str]) -> String {
        let output = self.run(args);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn the_native_alias_loads_explicit_identity_without_initializing_a_store() {
    let fixture = Fixture::new();
    let help = fixture.text(&["--help"]);
    assert!(help.contains("Load an agent's durable identity"));
    let brief = fixture.text(&["--instance", "instance.json"]);
    for expected in [
        "Synthetic identity",
        "Synthetic perspective",
        "Persistent reverie plan",
        "everyone in it reads every message",
    ] {
        assert!(brief.contains(expected), "{expected}");
    }
    assert!(!fixture.0.join("state").exists());
}

fn populate(fixture: &Fixture) {
    let directory = fixture.0.join("state");
    fs::create_dir(&directory).unwrap();
    fs::write(directory.join("profile.md"), "Private profile note").unwrap();
    fs::write(directory.join("legacy-history.json"), r#"[{"role":"user","content":"unimported question"},{"role":"assistant","content":"unimported answer"}]"#).unwrap();
    let db = rusqlite::Connection::open(directory.join("memory.sqlite")).unwrap();
    let legacy_assistant = "\x6a\x69\x6e\x78\x5f\x74\x65\x78\x74";
    db.execute_batch(&format!(
        "CREATE TABLE memories (id INTEGER PRIMARY KEY, kind TEXT, created_at REAL, user_text TEXT, {legacy_assistant} TEXT, text TEXT, meta TEXT);
         INSERT INTO memories VALUES (1,'episode',1,'existing question','existing answer','','{{}}');
         CREATE TABLE state(key TEXT PRIMARY KEY, value TEXT);
         INSERT INTO state VALUES ('mood','{{\"valence\": 0.7,\"arousal\": 0.8}}');
         CREATE TABLE beliefs(id INTEGER PRIMARY KEY,text TEXT,weight REAL,parent_id INTEGER,protected INTEGER,created_at REAL);
         INSERT INTO beliefs VALUES (1,'Private belief',4,NULL,0,1);
         CREATE TABLE reverie_documents(name TEXT PRIMARY KEY, revision INTEGER, body TEXT, updated_at REAL);
         INSERT INTO reverie_documents VALUES ('plan',7,'\"Stored plan\"',2);
         INSERT INTO reverie_documents VALUES ('lifecycle',1,'{{\"mode\":\"vacation\"}}',2);"
    )).unwrap();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs_f64();
    db.execute(
        "INSERT INTO memories (id,kind,created_at,text,meta) VALUES (2,'dream',?, 'fallback', ?)",
        rusqlite::params![now, r#"{"recall":"Private dream","ideas":[{"hypothesis":"Unverified thought","check":"test the evidence"}]}"#],
    ).unwrap();
    db.close().unwrap();
}

#[test]
fn scoped_cli_reads_legacy_data_without_rewriting_or_exposing_it_to_work() {
    let fixture = Fixture::new();
    populate(&fixture);
    let path = fixture.0.join("state/memory.sqlite");
    let original = fs::read(&path).unwrap();
    let private = fixture.text(&["--channel", "private"]);
    for expected in [
        "Stored plan",
        "Private belief",
        "Private profile note",
        "bright and happy",
        "Private dream",
        "Unverified dream hypothesis: Unverified thought",
        "user: existing question\nassistant: existing answer",
        "user: unimported question\nassistant: unimported answer",
        "You are on vacation",
    ] {
        assert!(private.contains(expected), "{expected}");
    }
    let work = fixture.text(&[]);
    assert!(work.contains("Stored plan"));
    assert!(work.contains("You are on vacation"));
    for private_text in [
        "Private belief",
        "Private profile note",
        "Private dream",
        "existing answer",
        "unimported answer",
    ] {
        assert!(!work.contains(private_text), "{private_text}");
    }
    assert_eq!(fs::read(path).unwrap(), original);
    assert!(!fixture.0.join("state/logs").exists());
}
