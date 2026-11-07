use super::*;
use std::{
    ffi::{OsStr, OsString},
    fs::{self, FileTimes},
    os::unix::{
        ffi::OsStringExt,
        fs::{PermissionsExt, symlink},
        net::UnixListener,
    },
    time::{Duration, SystemTime},
};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let mut random = [0; 16];
        getrandom::getrandom(&mut random).unwrap();
        let name: String = random.iter().map(|value| format!("{value:02x}")).collect();
        let path = std::env::temp_dir().join(format!("reverie-snapshot-{name}"));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        fs::create_dir(path.join("console")).unwrap();
        Self(path)
    }
    fn end(&self) -> Instant {
        Instant::now() + Duration::from_secs(60)
    }
    fn destination(&self) -> PathBuf {
        self.0.join("output").join("snapshot")
    }
    fn output(&self) {
        fs::create_dir(self.0.join("output")).unwrap();
        fs::set_permissions(self.0.join("output"), fs::Permissions::from_mode(0o700)).unwrap();
    }
    fn source(&self) -> PathBuf {
        self.0.join("source")
    }
    fn separate(&self) {
        fs::create_dir(self.source()).unwrap();
        fs::rename(self.0.join("console"), self.source().join("console")).unwrap();
        self.output();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn tool(name: &str) -> PathBuf {
    std::env::split_paths(&std::env::var_os("PATH").unwrap())
        .map(|path| path.join(name))
        .find(|path| path.is_file())
        .map(|path| fs::canonicalize(path).unwrap())
        .unwrap_or_else(|| panic!("owning snapshot test requires installed {name}"))
}
fn tools() -> SnapshotTools {
    SnapshotTools::capture_installed(&tool("tar"), &tool("getfattr"), &tool("getfacl")).unwrap()
}
fn fixture_command(name: &str, args: &[&OsStr]) {
    assert!(
        std::process::Command::new(tool(name))
            .args(args)
            .status()
            .unwrap()
            .success()
    );
}

#[test]
fn complete_owned_copy_restores_bytes_modes_acl_xattrs_hardlinks_and_symlinks() {
    let fixture = Fixture::new();
    fixture.separate();
    let console = fixture.source().join("console");
    fs::create_dir(console.join("accounts")).unwrap();
    let file = console.join("accounts/unknown.extension");
    fs::write(&file, [0, 255, 42, 0]).unwrap();
    fs::set_permissions(&file, fs::Permissions::from_mode(0o640)).unwrap();
    File::options()
        .write(true)
        .open(&file)
        .unwrap()
        .set_times(
            FileTimes::new()
                .set_modified(SystemTime::UNIX_EPOCH + Duration::new(1_700_000_000, 123_456_789)),
        )
        .unwrap();
    fs::hard_link(&file, console.join("accounts/hardlink")).unwrap();
    symlink("unknown.extension", console.join("accounts/link")).unwrap();
    fs::hard_link(
        console.join("accounts/link"),
        console.join("accounts/link-alias"),
    )
    .unwrap();
    fs::write(
        console.join(OsString::from_vec(vec![b'x', 0xff])),
        b"non-UTF8 filename",
    )
    .unwrap();
    fixture_command(
        "setfattr",
        &[
            OsStr::new("-n"),
            OsStr::new("user.snapshot"),
            OsStr::new("-v"),
            OsStr::new("0x0001ff"),
            file.as_os_str(),
        ],
    );
    fixture_command(
        "setfacl",
        &[
            OsStr::new("-m"),
            OsStr::new("u:12345:r--"),
            file.as_os_str(),
        ],
    );
    let mut snapshot = tools()
        .capture_console(&fixture.source(), &fixture.destination(), fixture.end())
        .unwrap();
    assert!(snapshot.entry_count() >= 7);
    snapshot.rehearse(fixture.end()).unwrap();
    assert!(snapshot.restore_rehearsed());
    assert_eq!(
        fs::read(
            fixture
                .destination()
                .join("rehearsal/console/accounts/unknown.extension")
        )
        .unwrap(),
        [0, 255, 42, 0]
    );
    assert_eq!(snapshot.scope_note(), SCOPE_NOTE);
    snapshot.close().unwrap();
}

#[test]
fn source_content_and_archive_replacement_are_refusals() {
    let fixture = Fixture::new();
    fixture.separate();
    fs::write(fixture.source().join("console/data"), b"old").unwrap();
    let mut snapshot = tools()
        .capture_console(&fixture.source(), &fixture.destination(), fixture.end())
        .unwrap();
    fs::write(fixture.source().join("console/data"), b"new").unwrap();
    assert!(snapshot.verify_source(fixture.end()).is_err());
    fs::rename(
        snapshot.archive_path(),
        fixture.destination().join("original.tar"),
    )
    .unwrap();
    fs::write(snapshot.archive_path(), b"foreign").unwrap();
    assert!(snapshot.rehearse(fixture.end()).is_err());
    assert_eq!(fs::read(snapshot.archive_path()).unwrap(), b"foreign");
    snapshot.close().unwrap();
}

#[test]
fn occupied_destination_and_source_overlap_preserve_existing_entries() {
    let fixture = Fixture::new();
    fixture.separate();
    fs::create_dir(fixture.destination()).unwrap();
    fs::write(fixture.destination().join("foreign"), b"keep").unwrap();
    assert!(
        tools()
            .capture_console(&fixture.source(), &fixture.destination(), fixture.end())
            .is_err()
    );
    assert_eq!(
        fs::read(fixture.destination().join("foreign")).unwrap(),
        b"keep"
    );
    assert!(
        tools()
            .capture_console(
                &fixture.source(),
                &fixture.source().join("console/snapshot"),
                fixture.end()
            )
            .is_err()
    );
    assert!(!fixture.source().join("console/snapshot").exists());
}

#[test]
fn external_hardlinks_and_special_files_are_not_silently_omitted() {
    let fixture = Fixture::new();
    fixture.separate();
    let file = fixture.source().join("console/linked");
    fs::write(&file, b"value").unwrap();
    fs::hard_link(&file, fixture.0.join("outside")).unwrap();
    let error = tools()
        .capture_console(&fixture.source(), &fixture.destination(), fixture.end())
        .err()
        .unwrap();
    assert_eq!(error.code(), "SNAPSHOT_EXTERNAL_HARDLINK");
    fs::remove_file(file).unwrap();
    let listener = UnixListener::bind(fixture.source().join("console/socket")).unwrap();
    let error = tools()
        .capture_console(
            &fixture.source(),
            &fixture.0.join("output/second"),
            fixture.end(),
        )
        .err()
        .unwrap();
    assert_eq!(error.code(), "SNAPSHOT_UNSUPPORTED_FILE_TYPE");
    drop(listener);
}

#[test]
fn observed_directory_rebind_and_expired_capture_refuse() {
    let fixture = Fixture::new();
    fixture.separate();
    let observed = ObservedDirectory::capture(&fixture.source()).unwrap();
    fs::rename(fixture.source(), fixture.0.join("original")).unwrap();
    fs::create_dir(fixture.source()).unwrap();
    assert!(observed.verify().is_err());
    observed.close().unwrap();
    let error = tools()
        .capture_console(&fixture.source(), &fixture.destination(), Instant::now())
        .err()
        .unwrap();
    assert_eq!(error.code(), "SNAPSHOT_DEADLINE");
    assert!(!fixture.destination().exists());
}

#[test]
fn observed_files_retain_entries_and_ancestors_and_refuse_special_types() {
    let fixture = Fixture::new();
    fixture.separate();
    let file = fixture.source().join("console/passwd");
    fs::write(&file, b"owned").unwrap();
    let observed = ObservedPath::capture(&file).unwrap();
    observed.verify().unwrap();
    let identity = observed.identity();
    fs::rename(fixture.source(), fixture.0.join("old-parent")).unwrap();
    fs::create_dir(fixture.source()).unwrap();
    fs::rename(
        fixture.0.join("old-parent/console"),
        fixture.source().join("console"),
    )
    .unwrap();
    use std::os::unix::fs::MetadataExt;
    let info = fs::metadata(&file).unwrap();
    assert_eq!(identity, (info.dev(), info.ino()));
    assert_eq!(
        observed.verify().unwrap_err().code(),
        "SNAPSHOT_ANCESTOR_CHANGED"
    );
    observed.close().unwrap();
    let observed = ObservedPath::capture(&file).unwrap();
    fs::write(&file, b"changed").unwrap();
    assert!(observed.verify().is_err());
    observed.close().unwrap();
    let _listener = UnixListener::bind(fixture.source().join("console/socket")).unwrap();
    assert_eq!(
        ObservedPath::capture(&fixture.source().join("console/socket"))
            .err()
            .unwrap()
            .code(),
        "SNAPSHOT_BIND_TYPE"
    );
}

#[test]
fn ambiguous_xattr_dump_cannot_forge_verified_values() {
    let fixture = Fixture::new();
    fixture.separate();
    let file = fixture.source().join("console/data");
    fs::write(&file, b"owned").unwrap();
    fixture_command(
        "setfattr",
        &[
            OsStr::new("-n"),
            OsStr::new("user.spoof=0x01\nuser.other"),
            OsStr::new("-v"),
            OsStr::new("0x02"),
            file.as_os_str(),
        ],
    );
    assert!(
        tools()
            .capture_console(&fixture.source(), &fixture.destination(), fixture.end())
            .is_err()
    );
}
