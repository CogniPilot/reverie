use super::*;
use crate::lease::ReservationState;
use std::os::unix::fs::{MetadataExt, PermissionsExt, symlink};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);

/// A private scratch directory; the workspaces root goes under it.
fn scratch() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "reverie-task-workspace-test-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&dir).unwrap();
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
    dir.canonicalize().unwrap()
}
fn mode(path: &Path) -> u32 {
    fs::symlink_metadata(path).unwrap().mode() & 0o777
}

#[test]
fn open_creates_a_private_owned_root_and_reopens_it() {
    let root = scratch().join("tasks");
    let workspaces = TaskWorkspaces::open(&root).unwrap();
    assert_eq!(workspaces.root(), root);
    assert_eq!(mode(&root), 0o700);
    assert_eq!(mode(&root.join(OWNED_MARKER)), 0o600);
    assert_eq!(mode(&root.join(".ops")), 0o700);
    fs::create_dir(root.join("job")).unwrap();
    TaskWorkspaces::open(&root).unwrap();
}

#[test]
fn an_unowned_root_with_entries_is_refused_untouched_and_an_empty_one_is_adopted() {
    let root = scratch();
    fs::write(root.join("someone-else"), b"x").unwrap();
    assert!(matches!(
        TaskWorkspaces::open(&root),
        Err(WorkspaceError::Unowned(_))
    ));
    assert!(!root.join(OWNED_MARKER).exists());
    assert!(!root.join(".ops").exists());
    let empty = scratch();
    TaskWorkspaces::open(&empty).unwrap();
    assert!(empty.join(OWNED_MARKER).exists());
}

#[test]
fn identifiers_follow_the_workspace_rule() {
    let workspaces = TaskWorkspaces::open(&scratch().join("tasks")).unwrap();
    for good in ["a", "A1_-x", "9", &"a".repeat(80)] {
        assert_eq!(workspaces.path(good).unwrap(), workspaces.root().join(good));
    }
    for bad in ["", "-a", "_a", "a.b", "a/b", "..", "é", &"a".repeat(81)] {
        assert!(
            matches!(workspaces.path(bad), Err(WorkspaceError::Identifier(_))),
            "{bad:?}"
        );
    }
}

#[test]
fn a_symlinked_workspace_is_refused() {
    let workspaces = TaskWorkspaces::open(&scratch().join("tasks")).unwrap();
    symlink("/", workspaces.root().join("job")).unwrap();
    assert!(matches!(
        workspaces.path("job"),
        Err(WorkspaceError::Symlink(_))
    ));
    assert!(matches!(
        workspaces.operation("job"),
        Err(WorkspaceError::Symlink(_))
    ));
}

#[test]
fn the_operation_lock_refuses_a_second_holder_at_once_and_frees_on_drop() {
    let workspaces = TaskWorkspaces::open(&scratch().join("tasks")).unwrap();
    let held = workspaces.operation("job").unwrap();
    let file = workspaces.root().join(".ops").join("job.lock");
    assert_eq!(mode(&file), 0o600);
    assert!(held.raw_fd() > 2);
    assert!(matches!(
        workspaces.operation("job"),
        Err(WorkspaceError::Busy(_))
    ));
    // Another open file description sees the same kernel lock, as Python's flock would.
    let other = File::open(&file).unwrap();
    assert!(Flock::lock(other, FlockArg::LockExclusiveNonblock).is_err());
    // A different workspace is independent.
    let _other = workspaces.operation("other").unwrap();
    drop(held);
    let again = workspaces.operation("job").unwrap();
    assert_eq!(fs::metadata(&file).unwrap().nlink(), 1);
    drop(again);
}

#[test]
fn write_replaces_the_metadata_durably_and_leaves_no_temporary() {
    let workspaces = TaskWorkspaces::open(&scratch().join("tasks")).unwrap();
    let job = workspaces.path("job").unwrap();
    fs::create_dir(&job).unwrap();
    workspaces
        .write(&job, br#"{"id": "job", "status": "allocated"}"#)
        .unwrap();
    assert_eq!(
        fs::read(job.join(METADATA)).unwrap(),
        b"{\"id\": \"job\", \"status\": \"allocated\"}\n"
    );
    workspaces
        .write(&job, br#"{"id": "job", "status": "running"}"#)
        .unwrap();
    assert_eq!(
        fs::read(job.join(METADATA)).unwrap(),
        b"{\"id\": \"job\", \"status\": \"running\"}\n"
    );
    assert!(!job.join(".reverie-task.json.tmp").exists());
    assert_eq!(mode(&job.join(METADATA)), 0o600);
}

#[test]
fn reserve_records_the_reservation_and_renews_only_an_existing_one() {
    let dir = scratch();
    let base = LeaseBase::own(&dir.join("leases")).unwrap();
    let workspaces = TaskWorkspaces::open(&dir.join("tasks")).unwrap();
    let job = workspaces.path("job").unwrap();
    fs::create_dir(&job).unwrap();
    assert!(matches!(
        workspaces.reserve(&base, &job, true),
        Err(WorkspaceError::Lease(_))
    ));
    let key = workspaces.reserve(&base, &job, false).unwrap();
    assert_eq!(
        lease::reservation_state(&base, &key),
        ReservationState::InUse
    );
    assert_eq!(workspaces.reserve(&base, &job, true).unwrap(), key);
    assert_eq!(
        lease::reservation_state(&base, &key),
        ReservationState::InUse
    );
}
