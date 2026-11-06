//! Actual worker constructor, owned filesystem aliases and retained phones.
use super::*;
use std::os::unix::fs::{FileTypeExt, MetadataExt, symlink};

fn bind_worker(fixture: &Fixture) -> std::result::Result<OfficePhone, OfficeBindFailure> {
    fixture
        .service
        .bind_worker_retained(ProfileSessionId::parse(SID).unwrap())
}
fn close_phone(fixture: &Fixture, phone: &OfficePhone) {
    fixture
        .service
        .close_phone(phone, Instant::now() + Duration::from_secs(2))
        .unwrap();
}
#[test]
fn worker_root_spellings_preserve_real_mkdir_effects_before_anchored_bind() {
    for case in [
        "plain",
        "dot",
        "repeat",
        "existing-parent",
        "missing-parent",
        "missing-root",
        "alias",
    ] {
        let fixture = fixture_with_socket_root(|root| match case {
            "dot" => root.join("./office"),
            "repeat" => PathBuf::from(format!("{}//office", root.display())),
            "existing-parent" => {
                fs::create_dir(root.join("entry")).unwrap();
                root.join("entry/../office")
            }
            "missing-parent" => root.join("entry/../office"),
            "missing-root" => root.join("new/missing/office"),
            "alias" => {
                fs::create_dir(root.join("real")).unwrap();
                symlink("real", root.join("alias")).unwrap();
                root.join("alias/office")
            }
            _ => root.join("office"),
        });
        let selected = match case {
            "alias" => fixture.root.join("real/office"),
            "missing-root" => fixture.root.join("new/missing/office"),
            _ => fixture.root.join("office"),
        };
        assert!(!selected.exists(), "constructor must remain lazy: {case}");
        let phone = bind_worker(&fixture).ok().expect(case);
        let socket = selected.join(SID).join("office.sock");
        assert!(
            fs::symlink_metadata(&socket)
                .unwrap()
                .file_type()
                .is_socket()
        );
        if case.ends_with("parent") {
            assert!(fixture.root.join("entry").is_dir());
        }
        // A real default-mode sibling observes the same process umask without
        // mutating it. Python uses default modes for all newly made parents.
        let default = fixture.root.join("default-mode-control");
        fs::create_dir(&default).unwrap();
        if case == "missing-root" {
            for parent in ["new", "new/missing", "new/missing/office"] {
                assert_eq!(
                    fs::metadata(fixture.root.join(parent)).unwrap().mode() & 0o777,
                    fs::metadata(&default).unwrap().mode() & 0o777
                );
            }
        }
        assert_eq!(
            fs::metadata(selected.join(SID)).unwrap().mode() & 0o777,
            0o700
        );
        assert!(
            queries(&fixture).is_empty(),
            "no fixed-server lookup: {case}"
        );
        close_phone(&fixture, &phone);
        assert!(!socket.exists());
        assert!(
            selected.join(SID).is_dir(),
            "source leaves directories: {case}"
        );
    }
}
#[test]
fn worker_regular_file_before_parent_refuses_before_resolver_and_keeps_primary_error() {
    let fixture = fixture_with_socket_root(|root| {
        fs::write(root.join("blocked"), b"owner entry").unwrap();
        root.join("blocked/../office")
    });
    let (error, owner) = bind_worker(&fixture).err().unwrap().into_parts();
    assert!(
        matches!(error, OfficeError::Io(ref error) if error.raw_os_error() == Some(libc::ENOTDIR))
    );
    assert!(owner.is_none());
    assert_eq!(
        fs::read(fixture.root.join("blocked")).unwrap(),
        b"owner entry"
    );
    assert!(!fixture.root.join("office").exists());
    assert!(fixture.service.offices.lock().unwrap().is_empty());
    assert!(queries(&fixture).is_empty());
}
#[test]
fn worker_final_session_symlink_refuses_without_touching_target() {
    let fixture = fixture_with_socket_root(|root| {
        fs::create_dir(root.join("office")).unwrap();
        fs::create_dir(root.join("target")).unwrap();
        fs::write(root.join("target/owner"), "preserve").unwrap();
        symlink("../target", root.join("office").join(SID)).unwrap();
        root.join("office")
    });
    let (error, owner) = bind_worker(&fixture).err().unwrap().into_parts();
    assert!(matches!(error, OfficeError::Refused));
    assert!(owner.is_none());
    assert!(
        fs::symlink_metadata(fixture.root.join("office").join(SID))
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(
        fs::read(fixture.root.join("target/owner")).unwrap(),
        b"preserve"
    );
    assert!(!fixture.root.join("target/office.sock").exists());
    assert!(fixture.service.offices.lock().unwrap().is_empty());
}
#[test]
fn worker_directory_effects_remain_on_known_and_retained_constructor_failures() {
    for point in [
        test_hooks::Failure::Runtime,
        test_hooks::Failure::StopAfterSpawn,
    ] {
        let fixture = fixture_with_socket_root(|root| root.join("entry/../office"));
        test_hooks::set(point);
        let (_, owner) = bind_worker(&fixture).err().unwrap().into_parts();
        assert!(fixture.root.join("entry").is_dir());
        assert!(fixture.root.join("office").join(SID).is_dir());
        if point == test_hooks::Failure::Runtime {
            assert!(owner.is_none());
        } else {
            let owner = owner.expect("actual stopped-after-spawn constructor");
            fixture
                .service
                .close_construction(&owner, Instant::now() + Duration::from_secs(2))
                .unwrap();
        }
        assert!(
            !fixture
                .root
                .join("office")
                .join(SID)
                .join("office.sock")
                .exists()
        );
    }
}
#[test]
fn fixed_constructor_cannot_select_worker_root_and_direct_bind_keeps_parent_refusal() {
    let fixture = Fixture::new("127.0.0.1:9".parse().unwrap());
    let (error, owner) = bind_worker(&fixture).err().unwrap().into_parts();
    assert!(matches!(error, OfficeError::Refused));
    assert!(owner.is_none());
    let (error, owner) = fixture
        .service
        .bind_retained(
            fixture.root.join("entry/../phone"),
            ProfileSessionId::parse(SID).unwrap(),
        )
        .err()
        .unwrap()
        .into_parts();
    assert!(matches!(error, OfficeError::Refused));
    assert!(owner.is_none());
    assert!(!fixture.root.join("entry").exists());
}
