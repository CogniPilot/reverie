//! The scenarios of `tests/test_collector_state.py` on real owned fixtures.
//! As there, only the administrator identity is simulated: these tests also
//! accept the test user as an owner, and touch no host service state.
use reverie_contracts::collector_state::{
    FOREIGN_STATE, INVALID_MARKER, MARKER, NOT_ADMINISTRATOR, NOT_DEDICATED, UNSAFE_ANCESTRY,
};
use reverie_observations::collector_state::{StateError, prepare};
use std::fs;
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    root: PathBuf,
    state: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "collector-state-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
        let state = root.join("collector");
        Self { root, state }
    }

    fn prepare(&self, path: &Path) -> Result<Vec<u32>, StateError> {
        let owners = [0, nix::unistd::getuid().as_raw()];
        prepare(&points(path), &owners)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::set_permissions(&self.root, fs::Permissions::from_mode(0o755));
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn points(path: &Path) -> Vec<u32> {
    path.to_str().unwrap().chars().map(u32::from).collect()
}

fn marker(state: &Path) -> PathBuf {
    state.join(".reverie-collector-state.json")
}

#[test]
fn repeatable_private_state_preserves_existing_observations() {
    let fixture = Fixture::new();
    assert_eq!(fixture.prepare(&fixture.state), Ok(points(&fixture.state)));
    assert_eq!(fs::read(marker(&fixture.state)).unwrap(), MARKER);
    let output = fixture.state.join("samples-fixture.jsonl");
    fs::write(&output, "preserve\n").unwrap();
    let stamp = |meta: fs::Metadata| (meta.mtime(), meta.mtime_nsec());
    let before = stamp(fs::metadata(marker(&fixture.state)).unwrap());
    assert!(fixture.prepare(&fixture.state).is_ok());
    assert_eq!(fs::read_to_string(&output).unwrap(), "preserve\n");
    let after = stamp(fs::metadata(marker(&fixture.state)).unwrap());
    assert_eq!(before, after);
    let mode = fs::metadata(&fixture.state).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o700);
}

#[test]
fn foreign_data_is_never_adopted_or_chowned() {
    let fixture = Fixture::new();
    fs::create_dir(&fixture.state).unwrap();
    fs::set_permissions(&fixture.state, fs::Permissions::from_mode(0o700)).unwrap();
    let victim = fixture.state.join("other-application");
    fs::write(&victim, "preserve").unwrap();
    assert_eq!(
        fixture.prepare(&fixture.state),
        Err(StateError::Refused(FOREIGN_STATE))
    );
    assert_eq!(fs::read_to_string(&victim).unwrap(), "preserve");
    assert!(!marker(&fixture.state).exists());
}

#[test]
fn symlink_and_writable_parent_are_refused_without_entering() {
    let fixture = Fixture::new();
    let outside = fixture.root.join("victim");
    fs::create_dir(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, &fixture.state).unwrap();
    assert_eq!(
        fixture.prepare(&fixture.state),
        Err(StateError::Refused(UNSAFE_ANCESTRY))
    );
    assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
    fs::remove_file(&fixture.state).unwrap();
    fs::set_permissions(&fixture.root, fs::Permissions::from_mode(0o777)).unwrap();
    assert_eq!(
        fixture.prepare(&fixture.state),
        Err(StateError::Refused(UNSAFE_ANCESTRY))
    );
    assert!(!fixture.state.exists());
}

#[test]
fn fifo_marker_refuses_immediately_and_never_replaces_it() {
    let fixture = Fixture::new();
    fs::create_dir(&fixture.state).unwrap();
    fs::set_permissions(&fixture.state, fs::Permissions::from_mode(0o700)).unwrap();
    let fifo = marker(&fixture.state);
    nix::unistd::mkfifo(&fifo, nix::sys::stat::Mode::from_bits_truncate(0o600)).unwrap();
    assert_eq!(
        fixture.prepare(&fixture.state),
        Err(StateError::Refused(INVALID_MARKER))
    );
    assert!(fs::symlink_metadata(&fifo).unwrap().file_type().is_fifo());
}

#[test]
fn symlinked_marker_is_an_os_error_naming_the_marker() {
    let fixture = Fixture::new();
    fs::create_dir(&fixture.state).unwrap();
    fs::set_permissions(&fixture.state, fs::Permissions::from_mode(0o700)).unwrap();
    let target = fixture.root.join("elsewhere");
    fs::write(&target, MARKER).unwrap();
    std::os::unix::fs::symlink(&target, marker(&fixture.state)).unwrap();
    let error = fixture.prepare(&fixture.state).unwrap_err();
    assert_eq!(
        error.message(),
        format!(
            "[Errno 40] Too many levels of symbolic links: '{}'",
            marker(&fixture.state).display()
        )
    );
}

#[test]
fn generic_relative_and_parent_state_paths_are_refused() {
    let fixture = Fixture::new();
    for path in ["/", "/var/lib", "/etc", "relative", "/var/a/../b"] {
        assert_eq!(
            fixture.prepare(Path::new(path)),
            Err(StateError::Refused(NOT_DEDICATED)),
            "{path}"
        );
    }
    assert!(!fixture.state.exists());
}

#[test]
fn the_command_refuses_a_non_administrator_without_touching_the_path() {
    if nix::unistd::geteuid().is_root() {
        return;
    }
    let fixture = Fixture::new();
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_reverie-collect-state"))
        .arg("--state-dir")
        .arg(&fixture.state)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        format!("reverie-collect-state: {NOT_ADMINISTRATOR}\n")
    );
    assert!(output.stderr.is_empty());
    assert!(!fixture.state.exists());
}
