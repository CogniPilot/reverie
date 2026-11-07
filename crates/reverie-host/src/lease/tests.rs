use super::*;
use std::fs;
use std::num::NonZeroUsize;
use std::os::unix::fs::PermissionsExt;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);

/// An owned synthetic tree under the test HOME: `leases/` and `work/`.
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let root = PathBuf::from(std::env::var_os("HOME").expect("owned test home")).join(format!(
            ".reverie-lease-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let root = fs::canonicalize(root).unwrap();
        fs::create_dir(root.join("work")).unwrap();
        Self(root)
    }
    fn base(&self) -> LeaseBase {
        LeaseBase::own(&self.0.join("leases")).unwrap()
    }
    fn dir(&self, relative: &str) -> PathBuf {
        let path = self.0.join("work").join(relative);
        fs::create_dir_all(&path).unwrap();
        path
    }
    fn names(&self) -> Vec<String> {
        let mut names = fs::read_dir(self.0.join("leases"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect::<Vec<_>>();
        names.sort();
        names
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
const WAIT: Duration = Duration::from_millis(200);

fn key(path: &Path) -> String {
    key_of(path).unwrap().unwrap()
}

#[test]
fn a_held_lease_protects_its_tree_and_releases_its_own_record() {
    let tree = Tree::new();
    let base = tree.base();
    let task = tree.dir("task");
    let child = tree.dir("task/child");
    let held = hold(
        &base,
        std::slice::from_ref(&child),
        Path::new("/bin/fixed-job"),
        WAIT,
    )
    .unwrap();
    assert_eq!(held.keys(), [key(&child)]);
    let k = key(&child);
    let pid = std::process::id();
    assert_eq!(
        tree.names(),
        [
            format!("{k}.{pid}.json"),
            format!("{k}.lock"),
            format!("{k}.path.json"),
            "barrier.lock".to_string(),
        ]
    );
    let record = fs::read_to_string(base.path().join(format!("{k}.{pid}.json"))).unwrap();
    assert!(record.starts_with(&format!(
        "{{\"version\": 1, \"path\": \"{}\", \"pid\": {pid}, \"start\": ",
        child.display()
    )));
    assert!(record.contains("\"argv0\": \"fixed-job\""), "{record}");
    // The parent sees the held descendant; the child sees it directly.
    for candidate in [&task, &child] {
        let (state, why) = check(candidate, Some(&tree.0), std::slice::from_ref(&base));
        assert_eq!(state, CheckState::InUse, "{why}");
        assert!(why.starts_with("leased: "), "{why}");
    }
    drop(held);
    assert!(
        !tree
            .names()
            .iter()
            .any(|name| name.ends_with(&format!(".{pid}.json")))
    );
    assert!(
        tree.names().contains(&format!("{k}.lock")),
        "locks are never unlinked"
    );
    assert_eq!(check(&task, Some(&tree.0), &[base]).0, CheckState::Free);
}

#[test]
fn an_ancestor_lease_protects_a_candidate_up_to_root() {
    let tree = Tree::new();
    let base = tree.base();
    let parent = tree.dir("parent");
    let child = tree.dir("parent/child");
    let _held = hold(&base, &[parent], Path::new("job"), WAIT).unwrap();
    assert_eq!(
        check(&child, Some(&tree.0), std::slice::from_ref(&base)).0,
        CheckState::InUse
    );
    // A root below the held ancestor leaves it outside the protected chain.
    assert_eq!(
        check(&child, Some(&child.join("..")), &[base]).0,
        CheckState::InUse,
        "root is the parent itself, which is still checked"
    );
}

#[test]
fn reservations_protect_until_unreserved_and_renew_requires_one() {
    let tree = Tree::new();
    let base = tree.base();
    let task = tree.dir("task");
    let renewal = reserve(&base, &task, "1h", "owner", None, WAIT, true).unwrap_err();
    assert_eq!(
        renewal.to_string(),
        format!("no reservation to renew: {}", task.display())
    );
    let k = reserve(&base, &task, "90m", "owner", Some("c-1"), WAIT, false).unwrap();
    let raw = fs::read(base.path().join(format!("{k}.reserve.json"))).unwrap();
    assert_eq!(
        reverie_contracts::lease_records::reservation_file_state(Some(&raw), now()),
        ReservationState::InUse
    );
    let (state, why) = check(&task, Some(&tree.0), std::slice::from_ref(&base));
    assert_eq!(
        (state, why.starts_with("reserved: ")),
        (CheckState::InUse, true)
    );
    assert_eq!(
        reserve(&base, &task, "1d", "", None, WAIT, true).unwrap(),
        k
    );
    unreserve(&base, &task, WAIT).unwrap();
    unreserve(&base, &task, WAIT).unwrap();
    assert_eq!(
        check(&task, Some(&tree.0), std::slice::from_ref(&base)).0,
        CheckState::Free
    );
    for (duration, message) in [
        ("25h", "a reservation lasts more than 0 and at most 24 h"),
        ("0s", "a reservation lasts more than 0 and at most 24 h"),
        ("1w", "duration must look like 90m, 6h or 1d: 1w"),
        // A multibyte final character is refused, never sliced mid-character.
        ("é", "duration must look like 90m, 6h or 1d: é"),
        ("1é", "duration must look like 90m, 6h or 1d: 1é"),
        ("٣h", "duration must look like 90m, 6h or 1d: ٣h"),
    ] {
        let error = reserve(&base, &task, duration, "", None, WAIT, false).unwrap_err();
        assert_eq!(
            (error.code(), error.to_string()),
            (LeaseCode::Unknown, message.into())
        );
    }
    let missing = reserve(&base, &tree.0.join("absent"), "1h", "", None, WAIT, false).unwrap_err();
    assert_eq!(missing.code(), LeaseCode::Busy);
}

#[test]
fn malformed_evidence_is_unknown_and_never_free() {
    let tree = Tree::new();
    let base = tree.base();
    let task = tree.dir("task");
    let k = key(&task);
    for reservation in [
        &b"null"[..],
        b"{",
        b"{\"version\": 1, \"created_utc\": 1, \"until_utc\": 9e9}",
    ] {
        fs::write(base.path().join(format!("{k}.reserve.json")), reservation).unwrap();
        let (state, why) = check(&task, Some(&tree.0), std::slice::from_ref(&base));
        assert_eq!(state, CheckState::Unknown, "{reservation:?}");
        assert!(
            why.starts_with("malformed or out-of-bounds reservation: "),
            "{why}"
        );
    }
    fs::remove_file(base.path().join(format!("{k}.reserve.json"))).unwrap();
    drop(hold(&base, std::slice::from_ref(&task), Path::new("job"), WAIT).unwrap());
    fs::write(base.path().join(format!("{k}.77.json")), b"{").unwrap();
    let (state, why) = check(&task, Some(&tree.0), std::slice::from_ref(&base));
    assert_eq!(
        (state, why.starts_with("malformed lease metadata: ")),
        (CheckState::Unknown, true)
    );
    let missing = LeaseBase::scan(&tree.0.join("absent")).unwrap_err();
    assert_eq!(missing.code(), LeaseCode::Unknown);
}

#[test]
fn a_busy_barrier_is_busy_and_a_missing_directory_cannot_be_held() {
    let tree = Tree::new();
    let base = tree.base();
    let task = tree.dir("task");
    let exclusive = barrier(&base, true, Duration::ZERO).unwrap();
    let error = hold(
        &base,
        std::slice::from_ref(&task),
        Path::new("job"),
        Duration::ZERO,
    )
    .unwrap_err();
    assert_eq!(error.code(), LeaseCode::Busy);
    assert_eq!(
        check(&task, Some(&tree.0), std::slice::from_ref(&base)).0,
        CheckState::InUse
    );
    drop(exclusive);
    let absent = hold(&base, &[tree.0.join("absent")], Path::new("job"), WAIT).unwrap_err();
    assert_eq!(absent.code(), LeaseCode::Busy);
    assert!(absent.to_string().starts_with("directory is missing: "));
}

#[test]
fn the_bounded_inventory_exhausts_without_freeing() {
    let tree = Tree::new();
    let base = tree.base();
    let task = tree.dir("task");
    for index in 0..4 {
        tree.dir(&format!("task/{index}"));
    }
    let bound = |entries| {
        Some(WalkBound {
            max_entries: NonZeroUsize::new(entries).unwrap(),
            deadline: Instant::now() + Duration::from_secs(5),
        })
    };
    let refused = janitor(&task, Some(&tree.0), std::slice::from_ref(&base), bound(3))
        .err()
        .unwrap();
    assert_eq!(refused.to_string(), "lease inventory bound exhausted");
    let held = janitor(&task, Some(&tree.0), &[base], bound(4)).unwrap();
    assert_eq!(held.own_keys().len(), 5);
}

fn retire(tree: &Tree, candidate: &Path, base: &LeaseBase) -> Result<Retirement> {
    retirement(
        candidate,
        &tree.0,
        &[LeaseBase::scan(base.path()).unwrap()],
        Instant::now() + Duration::from_secs(5),
        NonZeroUsize::new(4096).unwrap(),
        &mut DirectPaths,
    )
}

#[test]
fn retirement_classifies_registered_records_without_a_walk() {
    let tree = Tree::new();
    let base = tree.base();
    let task = tree.dir("task");
    let other = tree.dir("other");
    let free = retire(&tree, &task, &base).unwrap();
    assert_eq!(
        free.summary(),
        RetirementSummary {
            registered_records: 1,
            relevant_keys: 0
        },
        "Python counts barrier.lock before skipping it"
    );
    free.finish().unwrap();
    // An unrelated live reservation is counted but does not refuse.
    reserve(&base, &other, "1h", "", None, WAIT, false).unwrap();
    let unrelated = retire(&tree, &task, &base).unwrap();
    assert_eq!(
        unrelated.summary().registered_records,
        3,
        "barrier, path, reserve"
    );
    assert_eq!(unrelated.summary().relevant_keys, 0);
    drop(unrelated);
    // A released holder leaves an inactive relevant lock that stays held.
    drop(
        hold(
            &base,
            &[task.join("..").join("task")],
            Path::new("job"),
            WAIT,
        )
        .unwrap(),
    );
    let inactive = retire(&tree, &task, &base).unwrap();
    assert_eq!(inactive.summary().relevant_keys, 1);
    drop(inactive);
    let child = tree.dir("task/child");
    let held = hold(&base, &[child], Path::new("job"), WAIT).unwrap();
    let live = retire(&tree, &task, &base).err().unwrap();
    assert_eq!(live.code(), LeaseCode::InUse);
    assert_eq!(
        live.to_string(),
        "temporary tree has a live registered lease or reservation"
    );
    drop(held);
}

#[test]
fn retirement_refuses_untrusted_inventory_and_records() {
    let tree = Tree::new();
    let base = tree.base();
    let task = tree.dir("task");
    let k = key(&task);
    fs::write(base.path().join(".stray.tmp"), b"").unwrap();
    let stray = retire(&tree, &task, &base).err().unwrap();
    assert_eq!(stray.to_string(), "retirement lease inventory malformed");
    fs::remove_file(base.path().join(".stray.tmp")).unwrap();
    let record = base.path().join(format!("{k}.path.json"));
    fs::write(
        &record,
        b"{\"version\": 1, \"path\": \"/a\", \"path\": \"/b\"}",
    )
    .unwrap();
    fs::set_permissions(&record, fs::Permissions::from_mode(0o600)).unwrap();
    let duplicate = retire(&tree, &task, &base).err().unwrap();
    assert_eq!(duplicate.to_string(), "duplicate retirement lease metadata");
    fs::write(&record, b"{\"version\": 1, \"path\": \"/a\"}").unwrap();
    fs::set_permissions(&record, fs::Permissions::from_mode(0o622)).unwrap();
    let writable = retire(&tree, &task, &base).err().unwrap();
    assert_eq!(
        writable.to_string(),
        "retirement lease metadata unavailable"
    );
    fs::set_permissions(&record, fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(&record, b"{\"version\": 1, \"path\": \"/a/./b\"}").unwrap();
    let abnormal = retire(&tree, &task, &base).err().unwrap();
    assert_eq!(
        abnormal.to_string(),
        "retirement registered path unavailable"
    );
    let relative = retirement(
        Path::new("work/task"),
        &tree.0,
        std::slice::from_ref(&base),
        Instant::now() + Duration::from_secs(5),
        NonZeroUsize::new(1).unwrap(),
        &mut DirectPaths,
    );
    assert_eq!(
        relative.err().unwrap().to_string(),
        "canonical retirement lease root required"
    );
}

#[test]
fn retirement_finish_detects_a_replaced_lease_directory() {
    let tree = Tree::new();
    let base = tree.base();
    let task = tree.dir("task");
    let held = retire(&tree, &task, &base).unwrap();
    fs::rename(base.path(), tree.0.join("moved")).unwrap();
    fs::create_dir(base.path()).unwrap();
    assert_eq!(
        held.finish().unwrap_err().to_string(),
        "retirement lease directory changed"
    );
    let expired = retirement(
        &task,
        &tree.0,
        &[LeaseBase::scan(base.path()).unwrap()],
        Instant::now(),
        NonZeroUsize::new(1).unwrap(),
        &mut DirectPaths,
    );
    assert_eq!(
        expired.err().unwrap().to_string(),
        "retirement lease deadline exhausted"
    );
}

#[test]
fn abspath_is_lexical_like_posix_normpath() {
    for (input, expected) in [
        ("/a/./b/../c/", "/a/c"),
        ("//a//b", "//a/b"),
        ("///a", "/a"),
        ("/..", "/"),
        ("/", "/"),
    ] {
        assert_eq!(
            abspath(Path::new(input)).unwrap(),
            PathBuf::from(expected),
            "{input}"
        );
    }
}
