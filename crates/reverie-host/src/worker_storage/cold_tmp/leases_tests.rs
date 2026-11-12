use super::leases::Bases;
use super::leases::ClearKeys;
use super::*;
use reverie_contracts::{worker_cold_tmp::ColdConfiguration, worker_config};
use std::{
    fs::{self, OpenOptions},
    os::unix::fs::{OpenOptionsExt, PermissionsExt, symlink},
    time::Duration,
};
struct Fixture {
    root: super::tests::Fixture,
    home: PosixPath,
    target: PosixPath,
    base: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = super::tests::Fixture::new();
        for directory in [
            "home",
            "home/.local",
            "home/.local/state",
            "home/.local/state/reverie",
            "home/.local/state/reverie/leases",
            "tmp",
        ] {
            let path = root.path.join(directory);
            fs::create_dir(&path).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        Self {
            home: PosixPath::try_new(&native::python_text(&root.path.join("home"))).unwrap(),
            target: PosixPath::try_new(&native::python_text(&root.path.join("tmp"))).unwrap(),
            base: root.path.join("home/.local/state/reverie/leases"),
            root,
        }
    }
    fn capture(&self) -> Bases {
        let config = worker_config::decode(
            br#"{"coldTemporaryCleanup":{"version":1,"enabled":true,"hostLeaseDirectories":[]}}"#,
        )
        .unwrap();
        Bases::capture(
            &ColdConfiguration::capture(&config).unwrap().unwrap(),
            &self.home,
            &self.target,
            native::uid(),
        )
        .unwrap()
    }
    fn file(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let path = self.base.join(name);
        fs::write(&path, bytes).unwrap();
        path
    }
    fn end(&self) -> Instant {
        Instant::now() + Duration::from_secs(5)
    }
}
#[test]
fn barriers_are_real_and_missing_target_locks_are_never_created() {
    if crate::test_process::isolate_case(concat!(
        "worker_storage::cold_tmp::leases_tests::",
        "barriers_are_real_and_missing_target_locks_are_never_created"
    )) {
        return;
    }
    let fixture = Fixture::new();
    let mut first = fixture.capture();
    first.barriers(fixture.end()).unwrap();
    let mut second = fixture.capture();
    assert!(second.barriers(fixture.end()).is_err());
    second.close().unwrap();
    first
        .clear_locks(&BTreeSet::from(["1-2".into()]), fixture.end())
        .unwrap();
    assert!(!fixture.base.join("1-2.lock").exists());
    first.close().unwrap();
    let mut third = fixture.capture();
    third.barriers(fixture.end()).unwrap();
    third.close().unwrap();
}

#[test]
fn janitor_keys_include_every_real_directory_and_ancestors_but_not_symlink_targets() {
    let fixture = Fixture::new();
    let target = fixture.root.path.join("tmp");
    fs::create_dir(target.join("nested")).unwrap();
    fs::write(target.join("payload"), b"owned").unwrap();
    symlink(fixture.root.path.join("home"), target.join("outside-alias")).unwrap();
    let root = native::open_at(
        libc::AT_FDCWD,
        target.as_os_str(),
        libc::O_RDONLY | libc::O_DIRECTORY,
    )
    .unwrap();
    let stop = PosixPath::try_new(&native::python_text(&fixture.root.path)).unwrap();
    let keys = ClearKeys::observe(&root, &fixture.target, &stop, fixture.end()).unwrap();
    let tree = tree::Tree::scan(&root, native::uid(), fixture.end()).unwrap();
    assert_eq!(keys.directories, tree.directory_keys());
    assert_eq!(keys.directories.len(), 2);
    assert_eq!(keys.all.len(), 3);
    let home = fs::metadata(fixture.root.path.join("home")).unwrap();
    assert!(!keys.all.contains(&format!("{}-{}", home.dev(), home.ino())));
    native::close(root).unwrap();
}
#[test]
fn actual_shared_holder_and_live_reservation_refuse_without_deleting_anything() {
    if crate::test_process::isolate_case(concat!(
        "worker_storage::cold_tmp::leases_tests::",
        "actual_shared_holder_and_live_reservation_refuse_without_deleting_anything"
    )) {
        return;
    }
    let fixture = Fixture::new();
    let path = fixture.file("1-2.lock", b"");
    let holder = OpenOptions::new()
        .read(true)
        .write(true)
        .mode(0o600)
        .open(&path)
        .unwrap();
    holder.try_lock_shared().unwrap();
    let mut bases = fixture.capture();
    bases.barriers(fixture.end()).unwrap();
    assert!(
        bases
            .clear_locks(&BTreeSet::from(["1-2".into()]), fixture.end())
            .is_err()
    );
    bases.close().unwrap();
    native::close(holder).unwrap();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs_f64();
    let raw = serde_json::json!({"version":true,"created_utc":now-1.0,"until_utc":now+60.0});
    let reservation = fixture.file("1-2.reserve.json", &serde_json::to_vec(&raw).unwrap());
    let before = fs::read(&reservation).unwrap();
    let mut bases = fixture.capture();
    bases.barriers(fixture.end()).unwrap();
    assert!(
        bases
            .clear_locks(&BTreeSet::from(["1-2".into()]), fixture.end())
            .is_err()
    );
    bases.close().unwrap();
    assert_eq!(fs::read(&reservation).unwrap(), before);
    assert!(path.exists());
}
#[test]
fn clear_accepts_regular_symlink_uncapped_text_and_arbitrary_holder_shapes() {
    let fixture = Fixture::new();
    fixture.file("1-2.lock", b"");
    let path = fixture.root.path.join("outside-metadata");
    let raw = format!(
        "{{\"version\":0,\"version\":true,\"path\":\"/registered\",\"padding\":\"{}\"}}",
        "x".repeat(100000)
    );
    fs::write(&path, raw).unwrap();
    symlink(&path, fixture.base.join("1-2.path.json")).unwrap();
    for (name, raw) in [
        ("1-2.123.json", b"null".as_slice()),
        ("1-2..json", b"true"),
        ("1-2.other.json", b"[]"),
    ] {
        fixture.file(name, raw);
    }
    // This does not match Path.glob('<key>.*.json'). It must not be parsed.
    fixture.file("1-2.badjson", b"malformed");
    let mut bases = fixture.capture();
    bases.barriers(fixture.end()).unwrap();
    bases
        .clear_locks(&BTreeSet::from(["1-2".into()]), fixture.end())
        .unwrap();
    bases.close().unwrap();
    assert!(
        fs::symlink_metadata(fixture.base.join("1-2.path.json"))
            .unwrap()
            .file_type()
            .is_symlink()
    );
}
#[test]
fn fifo_metadata_refuses_without_blocking_or_removing_the_fifo_or_payload() {
    let fixture = Fixture::new();
    fixture.file("1-2.lock", b"");
    let path = fixture.base.join("1-2.reserve.json");
    nix::unistd::mkfifo(
        &path,
        nix::sys::stat::Mode::S_IRUSR | nix::sys::stat::Mode::S_IWUSR,
    )
    .unwrap();
    let before = fs::symlink_metadata(&path).unwrap();
    let mut bases = fixture.capture();
    bases.barriers(fixture.end()).unwrap();
    let started = Instant::now();
    assert!(
        bases
            .clear_locks(&BTreeSet::from(["1-2".into()]), fixture.end())
            .is_err()
    );
    bases.close().unwrap();
    assert!(started.elapsed() < Duration::from_secs(1));
    let after = fs::symlink_metadata(&path).unwrap();
    assert_eq!((before.dev(), before.ino()), (after.dev(), after.ino()));
}
