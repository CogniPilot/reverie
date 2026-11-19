use super::*;
use nix::{
    sys::stat::Mode,
    unistd::{mkdtemp, mkfifo},
};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt, symlink},
};

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        Self(mkdtemp(&std::env::temp_dir().join("hands-reader-XXXXXX")).unwrap())
    }

    fn trace(&self) -> PathBuf {
        self.0.join("events")
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn append(path: &Path, value: &[u8]) {
    OpenOptions::new()
        .append(true)
        .create(true)
        .mode(0o600)
        .open(path)
        .unwrap()
        .write_all(value)
        .unwrap();
}

fn line(kind: &str, value: &str) -> String {
    format!("{}\n", json!({"kind": kind, "text": value}))
}

fn events(reader: &mut Reader) -> serde_json::Value {
    serde_json::to_value(reader.poll().unwrap()).unwrap()
}

#[test]
fn tails_live_events_without_replaying_existing_reasoning() {
    let fixture = Fixture::new();
    let path = fixture.trace();
    append(&path, line("thinking", "earlier reasoning").as_bytes());
    let mut reader = Reader::new(&path, true).unwrap();
    assert_eq!(events(&mut reader), json!([]));
    append(&path, line("thinking", "new reasoning").as_bytes());
    append(&path, line("answer", "answer").as_bytes());
    assert_eq!(
        events(&mut reader),
        json!([
            {"kind": "thinking", "text": "new reasoning"}, {"kind": "answer", "text": "answer"}
        ])
    );
    assert_eq!(events(&mut reader), json!([]));
}

#[test]
fn reads_first_append_after_startup_without_creating_the_trace() {
    let fixture = Fixture::new();
    let path = fixture.trace();
    let mut reader = Reader::new(&path, true).unwrap();
    assert_eq!(events(&mut reader), json!([]));
    assert!(!path.exists());
    append(&path, line("answer", "first").as_bytes());
    assert_eq!(
        events(&mut reader),
        json!([{"kind": "answer", "text": "first"}])
    );
}

#[test]
fn resets_the_cursor_for_rotation_and_inode_replacement() {
    let fixture = Fixture::new();
    let path = fixture.trace();
    append(&path, b"{\"reset\":\"a\"}\n");
    append(&path, line("answer", "initial").as_bytes());
    let mut reader = Reader::new(&path, true).unwrap();
    fs::write(&path, b"{\"reset\":\"b\"}\n").unwrap();
    append(&path, line("answer", &"b".repeat(300)).as_bytes());
    assert_eq!(
        events(&mut reader),
        json!([{"kind": "answer", "text": "b".repeat(300)}])
    );
    let new = fixture.0.join("replacement");
    append(&new, line("answer", "third").as_bytes());
    fs::rename(new, &path).unwrap();
    assert_eq!(
        events(&mut reader),
        json!([{"kind": "answer", "text": "third"}])
    );
}

#[test]
fn reads_only_complete_valid_lines_and_redacts_before_returning() {
    let fixture = Fixture::new();
    let path = fixture.trace();
    let mut reader = Reader::new(&path, false).unwrap();
    let pending = line("thinking", "Authorization: Bearer fixture-secret\r\x1b\x00");
    append(&path, pending.trim_end_matches('\n').as_bytes());
    assert_eq!(events(&mut reader), json!([]));
    append(
        &path,
        b"\n{\"kind\":\"command\",\"text\":\"unrecognized\"}\n\xff\n",
    );
    append(
        &path,
        line("answer", &"x".repeat(EVENT_CHARS + 1)).as_bytes(),
    );
    assert_eq!(
        events(&mut reader),
        json!([{"kind": "thinking", "text": "[redacted]"}])
    );
}

#[test]
fn skips_only_the_preexisting_partial_record_at_startup() {
    let fixture = Fixture::new();
    let path = fixture.trace();
    append(&path, b"  ");
    let mut reader = Reader::new(&path, true).unwrap();
    append(&path, line("thinking", "historical").as_bytes());
    append(&path, line("answer", "new answer").as_bytes());
    assert_eq!(
        events(&mut reader),
        json!([{"kind": "answer", "text": "new answer"}])
    );
}

#[test]
fn recovers_from_an_oversized_line_without_decoding_its_suffix() {
    let fixture = Fixture::new();
    let path = fixture.trace();
    let mut reader = Reader::new(&path, false).unwrap();
    append(&path, &vec![b'x'; POLL_BYTES]);
    append(&path, line("thinking", "embedded suffix").as_bytes());
    append(&path, line("answer", "after oversized line").as_bytes());
    assert_eq!(events(&mut reader), json!([]));
    assert_eq!(
        events(&mut reader),
        json!([{"kind": "answer", "text": "after oversized line"}])
    );
}

#[test]
fn writer_lock_contention_does_not_advance_the_cursor() {
    let fixture = Fixture::new();
    let path = fixture.trace();
    append(&path, line("answer", "after unlock").as_bytes());
    let mut reader = Reader::new(&path, false).unwrap();
    let hold = Flock::lock(File::open(path).unwrap(), FlockArg::LockExclusive).unwrap();
    assert_eq!(events(&mut reader), json!([]));
    drop(hold);
    assert_eq!(
        events(&mut reader),
        json!([{"kind": "answer", "text": "after unlock"}])
    );
}

#[test]
fn refuses_symlinks_hard_links_wrong_modes_and_special_files() {
    let fixture = Fixture::new();
    let path = fixture.trace();
    append(&path, b"existing");
    let alias = fixture.0.join("alias");
    symlink(&path, &alias).unwrap();
    assert!(Reader::new(&alias, true).is_err());
    let fifo = fixture.0.join("fifo");
    mkfifo(&fifo, Mode::S_IRUSR | Mode::S_IWUSR).unwrap();
    assert!(Reader::new(&fifo, true).is_err());
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(Reader::new(&path, true).is_err());
    assert_eq!(fs::metadata(&path).unwrap().mode() & 0o777, 0o644);
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    fs::hard_link(&path, fixture.0.join("linked")).unwrap();
    assert!(Reader::new(&path, true).is_err());
    let shared = fixture.0.join("shared");
    fs::create_dir(&shared).unwrap();
    fs::set_permissions(&shared, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(Reader::new(&shared.join("file"), true).is_err());
}
