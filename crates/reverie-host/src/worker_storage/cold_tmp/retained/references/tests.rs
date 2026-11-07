use super::*;
use serde_json::Value;
use std::{
    fs as stdfs,
    os::unix::{
        fs::{PermissionsExt, symlink},
        net::UnixListener,
    },
    time::Duration,
};
struct Fixture {
    root: super::super::super::tests::Fixture,
    proc: PathBuf,
    target: PosixPath,
}
impl Fixture {
    fn new() -> Self {
        let root = super::super::super::tests::Fixture::new();
        let proc = root.path.join("proc");
        stdfs::create_dir(&proc).unwrap();
        let target = root.path.join("tmp");
        stdfs::create_dir(&target).unwrap();
        stdfs::write(target.join("owned"), b"never walk old data").unwrap();
        Self {
            root,
            proc,
            target: PosixPath::try_new(&native::python_text(&target)).unwrap(),
        }
    }
    fn pid(&self, pid: u32) -> PathBuf {
        let base = self.proc.join(pid.to_string());
        for dir in ["fd", "fdinfo", "net"] {
            stdfs::create_dir_all(base.join(dir)).unwrap();
        }
        stdfs::write(
            base.join("status"),
            format!("Name:\tfixture\nUid:\t{0}\t{0}\t{0}\t{0}\n", native::uid()),
        )
        .unwrap();
        stdfs::write(
            base.join("stat"),
            format!("{pid} (fixture) S {} 777", "0 ".repeat(18)),
        )
        .unwrap();
        stdfs::write(
            base.join("mountinfo"),
            stdfs::read("/proc/self/mountinfo").unwrap(),
        )
        .unwrap();
        stdfs::write(base.join("maps"), b"0-1 rw-p 0 00:00 0\n").unwrap();
        stdfs::write(
            base.join("net/unix"),
            b"Num RefCount Protocol Flags Type St Inode Path\n",
        )
        .unwrap();
        base
    }
    fn target(&self) -> PathBuf {
        native::python_path(&self.target.codepoints()).unwrap()
    }
    fn fd(&self, base: &Path, name: &str) -> PathBuf {
        let path = self.target().join("owned");
        symlink(&path, base.join("fd").join(name)).unwrap();
        let mount = native::reservation_location(&self.target).unwrap().0;
        let info = stdfs::metadata(path).unwrap();
        let fdinfo = base.join("fdinfo").join(name);
        stdfs::write(
            &fdinfo,
            format!(
                "pos:\t0\nflags:\t010\nmnt_id:\t{}\nino:\t{}\n",
                mount.as_str(),
                info.ino()
            ),
        )
        .unwrap();
        fdinfo
    }
    fn end(&self) -> Instant {
        Instant::now() + Duration::from_secs(10)
    }
    fn observe(&self) -> Result<ReferenceReport> {
        assert!(self.target().starts_with(&self.root.path));
        observe(&self.proc, &self.target, -1, self.end())
    }
}
#[test]
fn explicit_permission_unknown_does_not_hide_later_definite_holder() {
    let fixture = Fixture::new();
    let first = fixture.pid(42);
    let second = fixture.pid(43);
    fixture.fd(&second, "9");
    let mountinfo = first.join("mountinfo");
    stdfs::set_permissions(&mountinfo, stdfs::Permissions::from_mode(0o000)).unwrap();
    assert_eq!(
        stdfs::read(&mountinfo).unwrap_err().kind(),
        io::ErrorKind::PermissionDenied,
        "owning proof requires actual unprivileged read refusal"
    );
    let report = fixture.observe().unwrap();
    assert!(report.known_count() > 0);
    assert!(report.unknown_count() > 0);
    let raw: Value = serde_json::from_slice(&report.encode()).unwrap();
    assert_eq!(
        raw["unknownReferences"][0]["kind"],
        "MOUNT_METADATA_UNAVAILABLE"
    );
    assert!(
        raw["knownReferences"]
            .as_array()
            .unwrap()
            .iter()
            .any(|value| value["pid"] == 43 && value["kind"] == "FD_REFERENCE")
    );
    assert_eq!(raw["allInitiallyEnumeratedProcessesVisited"], true);
    assert_eq!(raw["absenceOfReferencesProven"], false);
    assert_eq!(raw["treeWalkPerformed"], false);
    assert_eq!(
        stdfs::read(fixture.target().join("owned")).unwrap(),
        b"never walk old data"
    );
}
#[test]
fn fd_identity_reads_stop_before_event_tail_and_refuse_long_or_duplicate_header() {
    let fixture = Fixture::new();
    let base = fixture.pid(42);
    let path = fixture.fd(&base, "9");
    let mut raw = stdfs::read(&path).unwrap();
    raw.extend(vec![b'x'; 1 << 20]);
    stdfs::write(&path, &raw).unwrap();
    assert!(fixture.observe().unwrap().known_count() > 0);
    for raw in [vec![b'x'; 4097], b"mnt_id: 1\nmnt_id: 1\nino: 2\n".to_vec()] {
        stdfs::write(&path, raw).unwrap();
        assert!(fixture.observe().is_err());
    }
}
#[test]
fn incomplete_live_process_and_corrupt_owned_rows_refuse_while_matching_zombie_skips() {
    let fixture = Fixture::new();
    let base = fixture.pid(42);
    stdfs::remove_file(base.join("maps")).unwrap();
    assert!(fixture.observe().is_err());
    stdfs::write(
        base.join("stat"),
        format!("42 (zombie) Z {} 777", "0 ".repeat(18)),
    )
    .unwrap();
    assert_eq!(fixture.observe().unwrap().known_count(), 0);
    stdfs::write(base.join("status"), b"Uid: 1 1 1\n").unwrap();
    assert!(fixture.observe().is_err());
}
#[test]
fn actual_owned_pid_namespace_collects_fd_and_unix_holders_without_deleting_any_data() {
    let name = "worker_storage::cold_tmp::retained::references::tests::actual_owned_pid_namespace_collects_fd_and_unix_holders_without_deleting_any_data";
    if crate::test_process::isolate_cold_namespace(name) {
        return;
    }
    let root = std::env::temp_dir().join("r");
    stdfs::create_dir(&root).unwrap();
    stdfs::set_permissions(&root, stdfs::Permissions::from_mode(0o700)).unwrap();
    let held = native::open_at(
        libc::AT_FDCWD,
        root.as_os_str(),
        libc::O_RDONLY | libc::O_DIRECTORY,
    )
    .unwrap();
    let before = held.metadata().unwrap();
    let target = PosixPath::try_new(&native::python_text(&root)).unwrap();
    let end = || Instant::now() + Duration::from_secs(10);
    assert_eq!(
        collect(&target, held.as_raw_fd(), end())
            .unwrap()
            .known_count(),
        0
    );
    stdfs::write(root.join("payload"), b"unchanged real bytes\0\xff").unwrap();
    let file = File::open(root.join("payload")).unwrap();
    let socket = root.join("s");
    let listener = UnixListener::bind(&socket).unwrap();
    let report = collect(&target, held.as_raw_fd(), end()).unwrap();
    native::close(file).unwrap();
    let descriptor: std::os::fd::OwnedFd = listener.into();
    native::close(File::from(descriptor)).unwrap();
    stdfs::remove_file(&socket).unwrap();
    let raw: Value = serde_json::from_slice(&report.encode()).unwrap();
    for kind in [
        "FD_REFERENCE",
        "UNIX_SOCKET_REFERENCE_IN_NAMESPACE",
        "SOCKET_REFERENCE",
    ] {
        assert!(
            raw["knownReferences"]
                .as_array()
                .unwrap()
                .iter()
                .any(|value| value["kind"] == kind),
            "{kind}: {raw}"
        );
    }
    assert_eq!(
        collect(&target, held.as_raw_fd(), end())
            .unwrap()
            .known_count(),
        0
    );
    assert_eq!(
        stdfs::read(root.join("payload")).unwrap(),
        b"unchanged real bytes\0\xff"
    );
    assert_eq!(raw["absenceOfReferencesProven"], false);
    assert_eq!(raw["treeWalkPerformed"], false);
    let named = stdfs::symlink_metadata(&root).unwrap();
    assert_eq!((named.dev(), named.ino()), (before.dev(), before.ino()));
    native::close(held).unwrap();
    stdfs::remove_dir_all(&root).unwrap();
}
