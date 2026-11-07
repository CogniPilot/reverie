use super::*;
use crate::worker_storage::cold_tmp::retained::scope::RetirementPaths;
use reverie_contracts::{worker_cold_tmp::ColdConfiguration, worker_config};
use serde_json::json;
use std::{
    fs as stdfs,
    os::unix::fs::{OpenOptionsExt, PermissionsExt, symlink},
    time::Duration,
};
mod oracle;
const SESSION: &str = "00000000-0000-0000-0000-000000000000";
struct Fixture {
    root: super::super::super::tests::Fixture,
    config: Configuration,
    paths: StoragePaths,
    policy: ColdConfiguration,
}
impl Fixture {
    fn new() -> Self {
        let root = super::super::super::tests::Fixture::new();
        let company = root.path.join("company.json");
        stdfs::write(&company, br#"{"employees":[]}"#).unwrap();
        stdfs::set_permissions(&company, stdfs::Permissions::from_mode(0o600)).unwrap();
        let raw = json!({"uid":native::uid(),"companyFile":company,"stateRoot":root.path.join("state"),
            "scratchRoot":root.path.join("scratch"),"mounts":[{"source":root.path.join("shared"),"destination":"/workspace"}],
            "coldTemporaryCleanup":{"version":1,"enabled":true,"strategy":"retain-and-replace","hostLeaseDirectories":[]}});
        let source = worker_config::decode(&serde_json::to_vec(&raw).unwrap()).unwrap();
        let config = Configuration::capture(&source).unwrap();
        let paths = storage_identity::storage_paths(
            &config.identity,
            &ProfileSessionId::parse(SESSION).unwrap(),
        )
        .unwrap();
        let fixture = Self {
            root,
            config,
            paths,
            policy: ColdConfiguration::capture(&source).unwrap().unwrap(),
        };
        for path in [
            fixture.base(),
            fixture.paths.scratch().join("tmp"),
            fixture.root.path.join("shared"),
        ] {
            private_tree(&path, &fixture.root.path);
        }
        stdfs::write(
            fixture.paths.scratch().join("tmp/.keep"),
            b"old data never inventoried",
        )
        .unwrap();
        fixture
    }
    fn base(&self) -> PathBuf {
        self.paths.home().join(".local/state/reverie/leases")
    }
    fn target(&self) -> PathBuf {
        self.paths.scratch().join("tmp")
    }
    fn end(&self) -> Instant {
        Instant::now() + Duration::from_secs(10)
    }
    fn scope(&self) -> RetirementPaths {
        RetirementPaths::capture(&self.config, &self.paths, &self.policy, self.end()).unwrap()
    }
    fn capture(&self) -> Bases {
        let original =
            super::super::super::super::temporary::path_text(&self.config, &self.paths).unwrap();
        let target = original.scratch().join(&PosixPath::from_scalar_text("tmp"));
        Bases::capture(&self.policy, original.home(), &target, native::uid()).unwrap()
    }
    fn write(&self, name: &str, raw: &[u8]) {
        let path = self.base().join(name);
        stdfs::write(&path, raw).unwrap();
        stdfs::set_permissions(path, stdfs::Permissions::from_mode(0o600)).unwrap();
    }
    fn registered(&self, target: &Path, recorded: &str) -> String {
        let info = stdfs::metadata(target).unwrap();
        let key = format!("{}-{}", info.dev(), info.ino());
        self.write(&format!("{key}.lock"), b"");
        self.write(
            &format!("{key}.path.json"),
            &serde_json::to_vec(&json!({"version":1,"path":recorded})).unwrap(),
        );
        key
    }
    fn open_lock(&self, key: &str) -> File {
        stdfs::OpenOptions::new()
            .read(true)
            .write(true)
            .mode(0o600)
            .open(self.base().join(format!("{key}.lock")))
            .unwrap()
    }
}
fn private_tree(path: &Path, stop: &Path) {
    stdfs::create_dir_all(path).unwrap();
    let mut current = path;
    while current.starts_with(stop) {
        stdfs::set_permissions(current, stdfs::Permissions::from_mode(0o700)).unwrap();
        if current == stop {
            break;
        }
        current = current.parent().unwrap();
    }
}
#[test]
fn actual_relevant_kernel_lock_and_barrier_remain_held_until_checked_close() {
    let fixture = Fixture::new();
    let scope = fixture.scope();
    let key = fixture.registered(&fixture.target(), "/tmp");
    let mut bases = fixture.capture();
    bases.barriers(fixture.end()).unwrap();
    let inventory = bases.retained_locks(&scope, fixture.end()).unwrap();
    assert_eq!((inventory.registered, inventory.relevant), (3, 1));
    let other = fixture.open_lock(&key);
    assert!(matches!(
        other.try_lock(),
        Err(stdfs::TryLockError::WouldBlock)
    ));
    native::close(other).unwrap();
    bases.close().unwrap();
    let other = fixture.open_lock(&key);
    other.try_lock().unwrap();
    native::close(other).unwrap();
    assert_eq!(
        stdfs::read(fixture.target().join(".keep")).unwrap(),
        b"old data never inventoried"
    );
}
#[test]
fn held_guest_tmp_refuses_but_actual_unrelated_guest_lease_stays_held() {
    for related in [true, false] {
        let fixture = Fixture::new();
        let scope = fixture.scope();
        let target = if related {
            fixture.target()
        } else {
            fixture.root.path.join("shared")
        };
        let key = fixture.registered(&target, if related { "/tmp" } else { "/workspace" });
        let holder = fixture.open_lock(&key);
        holder.try_lock_shared().unwrap();
        let mut bases = fixture.capture();
        bases.barriers(fixture.end()).unwrap();
        let result = bases.retained_locks(&scope, fixture.end());
        if related {
            assert!(result.is_err());
        } else {
            assert_eq!(result.unwrap().relevant, 0);
        }
        bases.close().unwrap();
        let another = fixture.open_lock(&key);
        assert!(matches!(
            another.try_lock(),
            Err(stdfs::TryLockError::WouldBlock)
        ));
        native::close(another).unwrap();
        native::close(holder).unwrap();
        assert!(fixture.target().join(".keep").exists());
    }
}
#[test]
fn live_reservation_refuses_even_without_kernel_lock_or_holder_heartbeat() {
    let fixture = Fixture::new();
    let scope = fixture.scope();
    let key = fixture.registered(&fixture.target(), "/tmp");
    stdfs::remove_file(fixture.base().join(format!("{key}.lock"))).unwrap();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs_f64();
    fixture.write(
        &format!("{key}.reserve.json"),
        &serde_json::to_vec(&json!({
        "version":1,"path":"/tmp","created_utc":now-1.0,"until_utc":now+60.0}))
        .unwrap(),
    );
    let mut bases = fixture.capture();
    bases.barriers(fixture.end()).unwrap();
    assert!(bases.retained_locks(&scope, fixture.end()).is_err());
    bases.close().unwrap();
    assert!(!fixture.base().join(format!("{key}.lock")).exists());
}
#[test]
fn inactive_malformed_records_and_registered_names_refuse_without_tree_walk() {
    for (name, raw) in [
        (
            "1-2.path.json",
            br#"{"version":true,"path":"/tmp"}"#.as_slice(),
        ),
        (
            "1-2.path.json",
            br#"{"version":1,"path":"/tmp","path":"/tmp"}"#,
        ),
        ("1-2.path.json", br#"{"version":1}"#),
        ("1-2.12.json", b"null"),
        ("1-2.wrong.json", b"{}"),
        ("1-2.12.json", br#"{"version":1,"path":"/tmp/../tmp"}"#),
    ] {
        let fixture = Fixture::new();
        fixture.write(name, raw);
        let scope = fixture.scope();
        let mut bases = fixture.capture();
        bases.barriers(fixture.end()).unwrap();
        assert!(
            bases.retained_locks(&scope, fixture.end()).is_err(),
            "{name}"
        );
        bases.close().unwrap();
        assert_eq!(stdfs::read(fixture.base().join(name)).unwrap(), raw);
        assert!(fixture.target().join(".keep").exists());
    }
}
#[test]
fn strict_reader_refuses_symlink_fifo_hardlink_writable_and_oversize_metadata() {
    let fixture = Fixture::new();
    let raw = br#"{"version":1,"path":"/outside"}"#;
    fixture.write("outside", raw);
    symlink("outside", fixture.base().join("1-2.path.json")).unwrap();
    nix::unistd::mkfifo(
        &fixture.base().join("3-4.path.json"),
        nix::sys::stat::Mode::S_IRUSR | nix::sys::stat::Mode::S_IWUSR,
    )
    .unwrap();
    stdfs::hard_link(
        fixture.base().join("outside"),
        fixture.base().join("5-6.path.json"),
    )
    .unwrap();
    fixture.write("7-8.path.json", raw);
    stdfs::set_permissions(
        fixture.base().join("7-8.path.json"),
        stdfs::Permissions::from_mode(0o620),
    )
    .unwrap();
    fixture.write("9-10.path.json", &vec![b' '; 65537]);
    let bases = fixture.capture();
    for name in [
        "1-2.path.json",
        "3-4.path.json",
        "5-6.path.json",
        "7-8.path.json",
        "9-10.path.json",
    ] {
        assert!(
            bases.bases[0]
                .retained_record(OsStr::new(name), fixture.end())
                .is_err(),
            "{name}"
        );
    }
    bases.close().unwrap();
    assert_eq!(stdfs::read(fixture.base().join("outside")).unwrap(), raw);
}
#[test]
fn global_registered_bound_counts_barrier_and_preserves_raw_leading_zero_keys() {
    let fixture = Fixture::new();
    let scope = fixture.scope();
    for n in 0..MAX_RECORDS - 1 {
        fixture.write(&format!("0-{n}.lock"), b"");
    }
    let mut bases = fixture.capture();
    bases.barriers(fixture.end()).unwrap();
    assert_eq!(
        bases
            .retained_locks(&scope, fixture.end())
            .unwrap()
            .registered,
        MAX_RECORDS
    );
    bases.close().unwrap();
    fixture.write("00-00.lock", b"");
    let mut bases = fixture.capture();
    bases.barriers(fixture.end()).unwrap();
    assert!(bases.retained_locks(&scope, fixture.end()).is_err());
    bases.close().unwrap();
    assert!(fixture.base().join("00-00.lock").exists());
}
