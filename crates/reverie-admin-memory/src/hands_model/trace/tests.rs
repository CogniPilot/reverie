use super::*;
use nix::{
    sys::stat::Mode,
    unistd::{mkdtemp, mkfifo},
};
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::PathBuf,
};

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        Self(mkdtemp(&std::env::temp_dir().join("hands-trace-XXXXXX")).unwrap())
    }

    fn file(&self) -> PathBuf {
        self.0.join("events")
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn redacts_keys_and_split_labels_without_leaking_their_values() {
    let fixture = Fixture::new();
    let path = fixture.file();
    let mut writer = Writer::new(&path, Some("configured-é-secret"), TRACE_BYTES).unwrap();
    writer
        .write(DisplayKind::Thinking, "first\x1b[31m\u{202e} configured-é-")
        .unwrap();
    writer
        .write(DisplayKind::Thinking, "secret done Auth")
        .unwrap();
    writer.write(DisplayKind::Thinking, "orization: ").unwrap();
    writer
        .write(DisplayKind::Thinking, "Bearer secret-of-another-service ")
        .unwrap();
    writer.write(DisplayKind::Answer, "Pass").unwrap();
    writer
        .write(DisplayKind::Answer, "word=other-secret!\r\x07")
        .unwrap();
    writer
        .write(DisplayKind::Thinking, "authorızatıon\u{202f}:\u{2003}Baſİc")
        .unwrap();
    writer
        .write(DisplayKind::Thinking, "\u{2002}unicode-credential first")
        .unwrap();
    writer.flush().unwrap();
    let raw = fs::read_to_string(&path).unwrap();
    for text in [
        "configured-é-secret",
        "secret-of-another-service",
        "other-secret",
        "unicode-credential",
        "\\u001b",
        "\\r",
        "\u{202e}",
    ] {
        assert!(!raw.contains(text), "{text}");
    }
    assert!(raw.contains("[redacted]"));
    assert_eq!(
        fs::metadata(path).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[test]
fn bounded_trace_rotates_and_preserves_the_generation_protocol() {
    let fixture = Fixture::new();
    let path = fixture.file();
    let mut writer = Writer::new(&path, None, 1024).unwrap();
    writer
        .write(DisplayKind::Answer, &"initial".repeat(20))
        .unwrap();
    writer.flush().unwrap();
    let first = fs::read_to_string(&path).unwrap();
    for index in 0..30 {
        writer
            .write(DisplayKind::Answer, &format!("{index}{}", "x".repeat(100)))
            .unwrap();
        writer.flush().unwrap();
        assert!(fs::metadata(&path).unwrap().len() <= 1024);
    }
    let last = fs::read_to_string(&path).unwrap();
    assert_ne!(first.lines().next(), last.lines().next());
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(last.lines().next().unwrap()).unwrap()["reset"]
            .as_str()
            .unwrap()
            .len(),
        32
    );
    assert!(last.contains("29xxx"));
}

#[test]
fn trace_refuses_symlinks_hard_links_and_unprivate_files() {
    let fixture = Fixture::new();
    let path = fixture.file();
    fs::write(&path, "original").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(Writer::new(&path, None, TRACE_BYTES).is_err());
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    symlink(&path, fixture.0.join("alias")).unwrap();
    assert!(Writer::new(&fixture.0.join("alias"), None, TRACE_BYTES).is_err());
    fs::hard_link(&path, fixture.0.join("second")).unwrap();
    assert!(Writer::new(&path, None, TRACE_BYTES).is_err());
    let fifo = fixture.0.join("fifo");
    mkfifo(&fifo, Mode::S_IRUSR | Mode::S_IWUSR).unwrap();
    assert!(Writer::new(&fifo, None, TRACE_BYTES).is_err());
    let directory = fixture.0.join("other");
    fs::create_dir(&directory).unwrap();
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(Writer::new(&directory.join("events"), None, TRACE_BYTES).is_err());
    symlink(&fixture.0, fixture.0.join("link")).unwrap();
    assert!(Writer::new(&fixture.0.join("link/events"), None, TRACE_BYTES).is_err());
    assert_eq!(fs::read_to_string(path).unwrap(), "original");
}
