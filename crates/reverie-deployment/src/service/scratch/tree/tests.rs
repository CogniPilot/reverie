use super::*;
use std::os::unix::{
    fs::{DirBuilderExt, symlink},
    net::UnixListener,
};

const ID: &str = "98765432-1000-4111-a111-0123456789ab";

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let temp = std::env::temp_dir().canonicalize().unwrap();
        let mut nonce = [0u8; 8];
        getrandom::getrandom(&mut nonce).unwrap();
        let root = temp.join(format!("rvp-{:016x}", u64::from_ne_bytes(nonce)));
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(root.join("laptops"))
            .unwrap();
        Self(root)
    }

    fn seat(&self, category: &str) -> PathBuf {
        let tmp = self.0.join("laptops").join(category).join(ID).join("tmp");
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&tmp)
            .unwrap();
        tmp
    }

    fn layout(&self) -> Layout {
        Layout::open(self.0.clone()).unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn clears_disposable_entries_without_changing_mount_directories() {
    let fixture = Fixture::new();
    let external = fixture.0.join("durable");
    fs::create_dir(&external).unwrap();
    fs::write(external.join("keep"), "durable").unwrap();
    let mut paths = Vec::new();
    for category in GROUPS {
        let tmp = fixture.seat(category);
        let identity = tmp.metadata().unwrap().ino();
        fs::create_dir(tmp.join("build")).unwrap();
        fs::write(tmp.join("build/output"), vec![0u8; 4096]).unwrap();
        symlink(&external, tmp.join("external-link")).unwrap();
        paths.push((tmp, identity));
    }

    let layout = fixture.layout();
    let targets = layout.targets().unwrap();
    assert_eq!(targets.len(), 3);
    for target in &targets {
        let inspection = target.inspect(false).unwrap();
        assert_eq!(inspection.row["eligibleEntries"], 2);
        assert!(inspection.row["eligibleBytes"].as_u64().unwrap() >= 4096);
        assert_eq!(inspection.row["allocatedBytesComplete"], true);
        layout.check(target).unwrap();
        target.clear(&inspection).unwrap();
    }
    for (tmp, inode) in paths {
        assert_eq!(tmp.metadata().unwrap().ino(), inode);
        assert_eq!(tmp.metadata().unwrap().mode() & 0o7777, 0o700);
        assert_eq!(fs::read_dir(tmp).unwrap().count(), 0);
    }
    assert_eq!(
        fs::read_to_string(external.join("keep")).unwrap(),
        "durable"
    );
}

#[test]
fn retains_protected_work_and_socket_subtrees() {
    let fixture = Fixture::new();
    let tmp = fixture.seat("employees");
    fs::create_dir_all(tmp.join("checkout/src/.git")).unwrap();
    fs::write(tmp.join(".reverie-task.json"), "task").unwrap();
    // Relative to a held descriptor so TMPDIR length does not affect sun_path.
    use std::os::fd::AsRawFd;
    let directory = File::open(&tmp).unwrap();
    let socket =
        UnixListener::bind(format!("/proc/self/fd/{}/sock", directory.as_raw_fd())).unwrap();
    fs::write(tmp.join("build"), "artifact").unwrap();
    let layout = fixture.layout();
    let target = layout.targets().unwrap().pop().unwrap();
    assert_eq!(target.inspect(false).unwrap().row["eligibleEntries"], 0);

    fs::remove_file(tmp.join(".reverie-task.json")).unwrap();
    let inspection = target.inspect(false).unwrap();
    assert_eq!(inspection.row["eligibleEntries"], 1);
    assert_eq!(
        inspection.row["protectedEntries"],
        json!(["checkout", "sock"])
    );
    target.clear(&inspection).unwrap();
    assert!(tmp.join("checkout/src/.git").is_dir());
    assert!(socket.local_addr().unwrap().as_pathname().unwrap().exists());
    assert!(!tmp.join("build").exists());
}

#[test]
fn refuses_replacement_and_ignores_non_employee_paths() {
    let fixture = Fixture::new();
    let tmp = fixture.seat("operator-sessions");
    fs::write(tmp.join("existing"), "old").unwrap();
    fs::create_dir_all(fixture.0.join("laptops/employees/manual/tmp")).unwrap();
    let layout = fixture.layout();
    let mut targets = layout.targets().unwrap();
    assert_eq!(targets.len(), 1);
    let target = targets.pop().unwrap();
    fs::rename(&tmp, tmp.with_file_name("old-tmp")).unwrap();
    symlink(tmp.with_file_name("old-tmp"), &tmp).unwrap();
    assert!(layout.check(&target).is_err());
    assert!(layout.targets().is_err());
    assert_eq!(fs::read_to_string(tmp.join("existing")).unwrap(), "old");
}

#[test]
fn clearing_hard_links_preserves_the_durable_name() {
    let fixture = Fixture::new();
    let durable = fixture.0.join("durable");
    fs::write(&durable, "keep me").unwrap();
    let tmp = fixture.seat("employees");
    fs::hard_link(&durable, tmp.join("link1")).unwrap();
    fs::hard_link(&durable, tmp.join("link2")).unwrap();
    let target = fixture.layout().targets().unwrap().pop().unwrap();
    let inspection = target.inspect(false).unwrap();
    assert_eq!(inspection.row["eligibleBytes"], 0);
    target.clear(&inspection).unwrap();
    assert_eq!(fs::read_to_string(durable).unwrap(), "keep me");
    assert_eq!(fs::read_dir(tmp).unwrap().count(), 0);
}

#[test]
fn only_forced_cleanup_includes_owned_read_only_directories() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    let tmp = fixture.seat("employees");
    let top = tmp.join("unpacked");
    let nested = top.join("nested");
    fs::create_dir_all(&nested).unwrap();
    fs::write(nested.join("cache"), "generated").unwrap();
    for dir in [&nested, &top] {
        fs::set_permissions(dir, fs::Permissions::from_mode(0o555)).unwrap();
    }
    let target = fixture.layout().targets().unwrap().pop().unwrap();
    let preview = target.inspect(false).unwrap();
    assert_eq!(preview.row["protectedEntries"], json!(["unpacked"]));
    let forced = target.inspect(true).unwrap();
    assert_eq!(forced.row["eligibleEntries"], 1);
    target.clear(&forced).unwrap();
    assert!(!top.exists());
}

#[test]
fn force_restores_original_mode_when_a_new_preservation_marker_refuses_clear() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    let tmp = fixture.seat("employees");
    let top = tmp.join("unpacked");
    let nested = top.join("nested");
    fs::create_dir_all(&nested).unwrap();
    fs::set_permissions(&top, fs::Permissions::from_mode(0o555)).unwrap();
    let target = fixture.layout().targets().unwrap().pop().unwrap();
    let forced = target.inspect(true).unwrap();
    fs::write(nested.join(".keep"), "unique").unwrap();
    assert!(target.clear(&forced).is_err());
    assert_eq!(top.metadata().unwrap().mode() & 0o7777, 0o555);
    assert!(nested.join(".keep").exists());
    fs::set_permissions(top, fs::Permissions::from_mode(0o755)).unwrap();
}
