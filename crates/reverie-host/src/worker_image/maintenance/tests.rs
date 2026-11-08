use super::*;
use std::{
    os::unix::fs::{DirBuilderExt, PermissionsExt},
    time::Duration,
};

struct Fixture {
    root: PathBuf,
    source: PathBuf,
    config: EffectiveWorkerConfig,
}
impl Fixture {
    fn new() -> Self {
        let root =
            nix::unistd::mkdtemp(&std::env::temp_dir().join("image-maintenance-XXXXXX")).unwrap();
        for name in [
            "data/console",
            "runtime/update-state",
            "runtime/worker-isolation",
        ] {
            let path = root.join(name);
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(path)
                .unwrap();
        }
        let source = root.join("runtime/worker-isolation/broker.json");
        let raw = format!(
            "{{\"uid\":{},\"deployment\":\"fixture\",\"serverContainer\":\"office\",\"companyRoot\":{:?},\"companyFile\":{:?},\"image\":\"sha256:{}\"}}",
            native::policy_effective_uid(),
            root.join("data"),
            root.join("data/console/company.json"),
            "a".repeat(64)
        );
        let config = reverie_contracts::worker_config::decode(raw.as_bytes()).unwrap();
        let result = Self {
            root,
            source,
            config,
        };
        result.write(&result.source, raw.as_bytes());
        result.write(&result.root.join("deployment.json"),format!("{{\"version\":1,\"containerName\":\"office\",\"companyRoot\":{:?},\"preserved\":true}}",result.root).as_bytes());
        result.write(&result.update(), b"existing maintenance contents");
        result
    }
    fn write(&self, path: &Path, bytes: &[u8]) {
        fs::write(path, bytes).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    fn update(&self) -> PathBuf {
        self.root.join("runtime/update-state/update.lock")
    }
    fn image(&self) -> PathBuf {
        self.source.parent().unwrap().join(".worker-image.lock")
    }
    fn capture(&self) -> std::result::Result<ImageMaintenanceLocks, Box<ImageMaintenanceFailure>> {
        ImageMaintenanceLocks::capture_at(
            &self.root,
            &self.source,
            &self.config,
            Instant::now() + Duration::from_secs(10),
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        native::test_faults::set(None, false);
        fs::remove_dir_all(&self.root).unwrap();
    }
}

#[test]
fn actual_registered_locks_remain_exclusive_until_known_component_close() {
    let fixture = Fixture::new();
    let mut locks = fixture
        .capture()
        .expect("both original native flocks must be owned");
    locks.assert_held_current().unwrap();
    let mut refused = Vec::new();
    for path in [fixture.update(), fixture.image()] {
        let probe = OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .unwrap();
        refused.push(native::memory_lock(&probe, true).is_err());
        native::close(probe).unwrap();
    }
    let mut second = fixture
        .capture()
        .err()
        .expect("same deployment cannot be entered twice");
    second.close_components().unwrap();
    locks.close().unwrap().assert_current().unwrap();
    let third = fixture
        .capture()
        .expect("checked close releases actual locks");
    third.close().unwrap().assert_current().unwrap();
    assert_eq!(refused, [true, true], "BOTH actual flocks must be held");
    assert_eq!(
        fs::read(fixture.update()).unwrap(),
        b"existing maintenance contents"
    );
    assert_eq!(fs::metadata(fixture.image()).unwrap().len(), 0);
}

#[test]
fn actual_update_contention_never_creates_the_later_image_lock() {
    let fixture = Fixture::new();
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(fixture.update())
        .unwrap();
    native::memory_lock(&file, true).unwrap();
    let mut failure = fixture
        .capture()
        .err()
        .expect("actual native flock is busy");
    failure.close_components().unwrap();
    let absent = !fixture.image().exists();
    native::close(file).unwrap();
    assert!(absent, "update lock must precede image lock effects");
}

#[test]
fn equal_bytes_foreign_lock_inode_stays_refused_without_retry() {
    let fixture = Fixture::new();
    let mut locks = fixture.capture().unwrap();
    let bytes = fs::read(fixture.update()).unwrap();
    fs::rename(fixture.update(), fixture.root.join("original-lock")).unwrap();
    fixture.write(&fixture.update(), &bytes);
    let first = locks.assert_held_current().unwrap_err();
    fs::remove_file(fixture.update()).unwrap();
    fs::rename(fixture.root.join("original-lock"), fixture.update()).unwrap();
    assert_eq!(
        locks.assert_held_current().unwrap_err().code(),
        first.code()
    );
    let mut failure = locks
        .close()
        .err()
        .expect("restoring a name cannot repair the attempt");
    failure.close_components().unwrap();
}

#[test]
fn foreign_company_binding_refuses_before_lock_creation() {
    let fixture = Fixture::new();
    fixture.write(
        &fixture.root.join("deployment.json"),
        br#"{"version":1,"containerName":"foreign","companyRoot":"/foreign"}"#,
    );
    let mut failure = fixture
        .capture()
        .err()
        .expect("canonical deployment must select same company");
    failure.close_components().unwrap();
    assert!(!fixture.image().exists());
}

#[test]
fn consumed_close_never_mints_closed_maintenance_or_clears_original_cause() {
    let fixture = Fixture::new();
    let locks = fixture.capture().unwrap();
    native::test_faults::set(None, true);
    let mut failure = locks
        .close()
        .err()
        .expect("native consumed-close opacity must remain owned");
    native::test_faults::set(None, false);
    assert!(failure.cause().has_unconfirmed_close());
    assert!(
        failure
            .close_components()
            .unwrap_err()
            .has_unconfirmed_close()
    );
}

#[test]
fn post_close_equal_bytes_deployment_or_lock_replacement_is_not_current() {
    for relative in [
        "deployment.json",
        "runtime/update-state/update.lock",
        "runtime/worker-isolation/.worker-image.lock",
    ] {
        let fixture = Fixture::new();
        let closed = fixture.capture().unwrap().close().unwrap();
        closed.assert_current().unwrap();
        let path = fixture.root.join(relative);
        let bytes = fs::read(&path).unwrap();
        fs::rename(&path, fixture.root.join("original-terminal-leaf")).unwrap();
        fixture.write(&path, &bytes);
        let observed = closed.assert_current();
        // Same-byte replacement preserves contents while changing the actual
        // terminal inode. Capture the result before fixture cleanup/verdict.
        drop(closed);
        assert!(
            observed.is_err(),
            "post-close replacement of {relative} must refuse"
        );
    }
}
