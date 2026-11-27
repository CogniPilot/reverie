use super::*;

#[test]
fn reference_checks_both_current_mounts_without_discarding_device_identity() {
    let home = "4:5:1000:100:448".parse::<Directory>().unwrap();
    let nix = "4:6:1000:100:448".parse::<Directory>().unwrap();
    let read = || Storage {
        version: 1,
        purpose: "reverie-boxed-storage-observation-v1",
        holder_start_ticks: None,
        home: home.clone(),
        nix: nix.clone(),
    };
    let accepted = compared_reference(read(), &home, &nix).unwrap();
    assert_eq!(accepted.purpose, "reverie-boxed-storage-reference-v1");
    assert_eq!(accepted.holder_start_ticks, None);
    for different in [
        "9:5:1000:100:448",
        "4:9:1000:100:448",
        "4:5:1001:100:448",
        "4:5:1000:101:448",
        "4:5:1000:100:493",
    ] {
        let other = different.parse::<Directory>().unwrap();
        assert!(
            compared_reference(read(), &other, &nix).is_err(),
            "{different}"
        );
    }
    assert!(compared_reference(read(), &home, &home).is_err());
}

#[test]
fn reference_inputs_are_canonical_and_bounded() {
    for invalid in [
        "4:0:1000:100:448",
        "4:05:1000:100:448",
        "4:5:4294967296:100:448",
        "4:5:1000:4294967296:448",
        "4:5:1000:100:4096",
        "4:5:1000:100:-1",
        "4:5:1000:100:",
        "4:5:1000:100:448:1",
        "/run/reverie-worker-home",
    ] {
        assert!(invalid.parse::<Directory>().is_err(), "{invalid}");
    }
}

#[test]
fn filesystem_id_is_checked_on_the_open_directory() {
    let mut files = Files::new();
    let index = files.storage("/", false).unwrap();
    let descriptor = files.get(index);
    let volume = rustix::fs::fstatvfs(descriptor).unwrap();
    let metadata = nix::sys::statfs::fstatfs(descriptor).unwrap();
    let expected = volume.f_fsid;
    let ext = metadata.filesystem_type() == nix::sys::statfs::EXT4_SUPER_MAGIC;
    assert_eq!(
        verify_filesystem(&files, index, expected).is_ok(),
        ext && expected != 0
    );
    assert!(verify_filesystem(&files, index, expected ^ 1).is_err());
    assert!(verify_filesystem(&files, index, 0).is_err());
}

#[test]
fn filesystem_observation_reports_what_the_verifier_checks() {
    let mut files = Files::new();
    let index = files.storage("/", false).unwrap();
    let seen = filesystem(&files, index).unwrap();
    let id = seen.id.parse::<u64>().unwrap();
    assert_eq!(seen.id, id.to_string());
    // The reported pair is exactly what `--filesystem-id` is later verified against.
    assert_eq!(
        verify_filesystem(&files, index, id).is_ok(),
        seen.ext4 && id != 0
    );
    assert_eq!(filesystem(&files, index).unwrap(), seen);
}

#[test]
fn filesystem_observation_has_one_closed_shape() {
    let directory = |raw: &str| raw.parse::<Directory>().unwrap();
    let encoded = serde_json::to_value(FilesystemObservation {
        version: 1,
        purpose: "reverie-boxed-storage-filesystem-observation-v1",
        home: directory("4:5:1000:100:448"),
        nix: directory("4:6:1000:100:448"),
        home_filesystem: Filesystem {
            ext4: true,
            id: "77".into(),
        },
        nix_filesystem: Filesystem {
            ext4: true,
            id: "77".into(),
        },
    })
    .unwrap();
    assert_eq!(
        encoded,
        serde_json::json!({
            "version": 1,
            "purpose": "reverie-boxed-storage-filesystem-observation-v1",
            "home": {"dev": "4", "ino": "5", "uid": 1000, "gid": 100, "mode": 448},
            "nix": {"dev": "4", "ino": "6", "uid": 1000, "gid": 100, "mode": 448},
            "homeFilesystem": {"ext4": true, "id": "77"},
            "nixFilesystem": {"ext4": true, "id": "77"},
        })
    );
}
