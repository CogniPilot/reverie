//! Actual exclusive-open collision controls for the intentional correction to
//! original _write_json's occupied predictable temporary truncation.
use super::*;
use crate::worker_storage::cold_tmp::tests::Fixture;
use std::{
    fs as stdfs,
    os::unix::fs::{MetadataExt, symlink},
    time::Duration,
};
fn base(fixture: &Fixture) -> Base {
    Base {
        directory: Directory::open(
            PosixPath::from_scalar_text(fixture.path.to_str().unwrap()),
            native::uid(),
        )
        .unwrap(),
        barrier: None,
        locks: Vec::new(),
    }
}
fn end() -> Instant {
    Instant::now() + Duration::from_secs(5)
}
#[test]
fn occupied_path_and_reservation_temps_preserve_regular_hardlink_and_symlink_bytes_and_inodes() {
    for kind in ["path", "reservation"] {
        for link in ["regular", "hardlink", "symlink"] {
            let fixture = Fixture::new();
            let attempt = NativeOperationId::from_random_bytes([7; 16]);
            let temporary = fixture
                .path
                .join(format!(".retained-{}-{kind}.tmp", attempt.as_str()));
            let backing = fixture.path.join("foreign-backing");
            let target = fixture.path.join("1-2.path.json");
            stdfs::write(&backing, b"foreign\0\xffbytes").unwrap();
            stdfs::write(&target, b"unchanged old record").unwrap();
            match link {
                "regular" => stdfs::write(&temporary, b"foreign\0\xffbytes").unwrap(),
                "hardlink" => stdfs::hard_link(&backing, &temporary).unwrap(),
                "symlink" => symlink(&backing, &temporary).unwrap(),
                _ => unreachable!(),
            }
            let before = stdfs::symlink_metadata(&temporary).unwrap();
            let backing_before = stdfs::metadata(&backing).unwrap();
            let base = base(&fixture);
            assert!(
                base.replace_epoch_record(
                    OsStr::new("1-2.path.json"),
                    b"new native record",
                    &attempt,
                    kind,
                    end()
                )
                .is_err()
            );
            let after = stdfs::symlink_metadata(&temporary).unwrap();
            assert_eq!(
                (before.dev(), before.ino(), before.mode(), before.nlink()),
                (after.dev(), after.ino(), after.mode(), after.nlink())
            );
            assert_eq!(stdfs::read(&temporary).unwrap(), b"foreign\0\xffbytes");
            assert_eq!(stdfs::read(&backing).unwrap(), b"foreign\0\xffbytes");
            let backing_after = stdfs::metadata(&backing).unwrap();
            assert_eq!(
                (
                    backing_before.dev(),
                    backing_before.ino(),
                    backing_before.nlink()
                ),
                (
                    backing_after.dev(),
                    backing_after.ino(),
                    backing_after.nlink()
                )
            );
            assert_eq!(stdfs::read(&target).unwrap(), b"unchanged old record");
            if link == "symlink" {
                assert_eq!(stdfs::read_link(&temporary).unwrap(), backing);
            }
            base.directory.close().unwrap();
        }
    }
}
#[test]
fn absent_path_and_reservation_temps_publish_then_leave_no_temporary_entry() {
    for kind in ["path", "reservation"] {
        let fixture = Fixture::new();
        let attempt = NativeOperationId::from_random_bytes([9; 16]);
        let base = base(&fixture);
        base.replace_epoch_record(
            OsStr::new("1-2.path.json"),
            b"native\0record",
            &attempt,
            kind,
            end(),
        )
        .unwrap();
        assert_eq!(
            stdfs::read(fixture.path.join("1-2.path.json")).unwrap(),
            b"native\0record"
        );
        assert!(
            !fixture
                .path
                .join(format!(".retained-{}-{kind}.tmp", attempt.as_str()))
                .exists()
        );
        base.directory.close().unwrap();
    }
}
