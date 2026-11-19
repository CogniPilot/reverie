use super::*;
use nix::unistd::{mkdtemp, mkfifo};
use std::{fs, os::unix::fs::symlink, path::PathBuf};

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        Self(mkdtemp(&std::env::temp_dir().join("hands-log-XXXXXX")).unwrap())
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn appends_the_existing_jsonl_format_and_repairs_readable_permissions() {
    let fixture = Fixture::new();
    let path = fixture.0.join("trace");
    let previous = r#"{"query": "old"}"#;
    let next = r#"{"query": "caf\u00e9"}"#;
    append(&path, previous.into()).unwrap();
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    fs::set_permissions(&path, Permissions::from_mode(0o644)).unwrap();
    append(&path, next.into()).unwrap();
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        format!("{previous}\n{next}\n")
    );
    assert_eq!(
        fs::metadata(path).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[test]
fn refuses_symlinks_fifos_and_multiline_input() {
    let fixture = Fixture::new();
    let target = fixture.0.join("existing");
    let alias = fixture.0.join("alias");
    let fifo = fixture.0.join("fifo");
    fs::write(&target, "existing").unwrap();
    symlink(&target, &alias).unwrap();
    mkfifo(&fifo, Mode::S_IRUSR | Mode::S_IWUSR).unwrap();
    for path in [alias, fifo] {
        assert!(append(&path, "{}".into()).is_err());
    }
    assert!(append(&target, "{}\n{}".into()).is_err());
    assert_eq!(fs::read_to_string(target).unwrap(), "existing");
}
