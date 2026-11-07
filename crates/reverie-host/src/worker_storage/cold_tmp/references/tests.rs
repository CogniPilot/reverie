use super::*;
use std::{fs, os::unix::fs::symlink, time::Duration};
fn fixture() -> (super::super::tests::Fixture, PathBuf) {
    let fixture = super::super::tests::Fixture::new();
    let proc = fixture.path.join("proc");
    fs::create_dir(&proc).unwrap();
    let base = proc.join("42");
    fs::create_dir(&base).unwrap();
    fs::create_dir(base.join("fd")).unwrap();
    fs::write(
        base.join("status"),
        format!("Name:\towned\nUid:\t{0}\t{0}\t{0}\t{0}\n", native::uid()),
    )
    .unwrap();
    fs::write(
        base.join("stat"),
        format!("42 (owned fixture) S {} 777", "0 ".repeat(18)),
    )
    .unwrap();
    fs::write(base.join("maps"), b"0-1 rw-p 0 00:00 0\n").unwrap();
    (fixture, proc)
}
fn end() -> Instant {
    Instant::now() + Duration::from_secs(3)
}
#[test]
fn known_fd_cwd_and_map_inodes_refuse_and_only_exact_own_fd_is_ignored() {
    let (fixture, proc) = fixture();
    let base = proc.join("42");
    let payload = fixture.path.join("payload");
    fs::write(&payload, b"owned").unwrap();
    let info = fs::metadata(&payload).unwrap();
    let keys = BTreeSet::from([(info.dev(), info.ino())]);
    let fd = base.join("fd/9");
    symlink(&payload, &fd).unwrap();
    assert!(observe(&proc, &keys, -1, native::uid(), 42, end()).is_err());
    observe(&proc, &keys, 9, native::uid(), 42, end()).unwrap();
    assert!(observe(&proc, &keys, 9, native::uid(), 43, end()).is_err());
    fs::remove_file(fd).unwrap();
    symlink(&payload, base.join("cwd")).unwrap();
    assert!(observe(&proc, &keys, -1, native::uid(), 42, end()).is_err());
    fs::remove_file(base.join("cwd")).unwrap();
    fs::write(
        base.join("maps"),
        format!(
            "0-1 rw-p 0 {:x}:{:x} {} /payload\n",
            nix::sys::stat::major(info.dev()),
            nix::sys::stat::minor(info.dev()),
            info.ino()
        ),
    )
    .unwrap();
    assert!(observe(&proc, &keys, -1, native::uid(), 42, end()).is_err());
    assert_eq!(fs::read(payload).unwrap(), b"owned");
}
#[test]
fn malformed_owned_credentials_and_partial_live_process_refuse_but_zombie_skips() {
    let (_fixture, proc) = fixture();
    let base = proc.join("42");
    let keys = BTreeSet::new();
    fs::remove_file(base.join("maps")).unwrap();
    assert!(observe(&proc, &keys, -1, native::uid(), 42, end()).is_err());
    fs::write(
        base.join("stat"),
        format!("42 (zombie) Z {} 777", "0 ".repeat(18)),
    )
    .unwrap();
    observe(&proc, &keys, -1, native::uid(), 42, end()).unwrap();
    fs::write(base.join("status"), b"Uid: 1 1 1\n").unwrap();
    assert!(observe(&proc, &keys, -1, native::uid(), 42, end()).is_err());
}
#[test]
fn actual_proc_never_admits_an_unignored_owned_directory_descriptor() {
    let fixture = super::super::tests::Fixture::new();
    let info = fs::metadata(&fixture.path).unwrap();
    let keys = BTreeSet::from([(info.dev(), info.ino())]);
    // This process really retains the directory. An earlier same-UID visibility
    // gap may also refuse; no reason-specific absence claim is made here.
    assert!(strict(&keys, -1, end()).is_err());
    assert!(fixture.path.is_dir());
}
