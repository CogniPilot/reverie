//! Owned filesystem/descriptor controls only. Birth documents below are DATA
//! fixtures; no native broker origin, website consent or pool is fabricated.
mod fixture;
use super::*;
use fixture::Fixture;
use std::{
    fs,
    os::{
        fd::AsRawFd,
        unix::fs::{MetadataExt, PermissionsExt, symlink},
    },
    time::Duration,
};

#[test]
fn unmeasured_retained_birth_refuses_before_publication_directory_or_engine_effects() {
    let tree = Fixture::new();
    let birth = tree.birth();
    let config=reverie_contracts::worker_config::decode(&serde_json::to_vec(&serde_json::json!({
        "workerPoolProvider":{"version":1,"purpose":"reverie-docker-worker-pool-provider-v1","policy":birth.policy()}
    })).unwrap()).unwrap();
    let provider = reverie_contracts::worker_pool::WorkerPoolProvider::from_config(&config)
        .unwrap()
        .unwrap();
    let anchor = serde_json::from_value(serde_json::json!({
        "containerId":"a".repeat(64),"originalBirthDigest":"b".repeat(64),
        "bootId":"11111111-1111-4111-8111-111111111111","pid":42,"processStart":"100",
        "parentIdentity":[12,22],"leafIdentity":[12,27]
    }))
    .unwrap();
    let retained =
        ControllerServiceBirth::from_installed_provider(birth, &provider, Some(anchor)).unwrap();
    let end = Instant::now() + Duration::from_secs(10);
    let mut owner =
        ControllerBirthPublication::new(&tree.runtime, retained, tree.root.clone(), end).unwrap();
    owner.compatibility = Some(
        super::super::birth_compatibility::ControllerBirthCompatibility::without_factory_for_test(
            &tree.runtime,
            end,
        ),
    );
    let failure = owner.publish().unwrap_err();
    assert_eq!(
        failure.birth_compatibility_error().unwrap().code(),
        "WORKER_POOL_CONTROLLER_BIRTH_CAPABILITY_UNMEASURED"
    );
    assert!(!tree.root.join("worker-pool").exists());
    assert_eq!(tree.starts.load(std::sync::atomic::Ordering::SeqCst), 0);
    assert!(
        owner.publish().is_err(),
        "no fallback or fresh offer after refusal"
    );
    owner.close().unwrap();
}

#[test]
fn birth_metadata_has_exact_bytes_modes_and_readonly_receipt_without_activation() {
    let tree = Fixture::new();
    let mut owner = tree.owner();
    owner.publish().unwrap();
    let reference = owner.reference_data().unwrap();
    let version = tree.versions().join(reference.filename());
    assert_eq!(
        fs::read(&version).unwrap(),
        owner.birth_data().encode().unwrap()
    );
    assert_eq!(fs::metadata(&version).unwrap().mode() & 0o7777, 0o440);
    assert_eq!(
        fs::metadata(tree.versions()).unwrap().mode() & 0o7777,
        0o750
    );
    assert!(owner.writer.is_none());
    let flags = nix::fcntl::fcntl(
        owner.reader.as_ref().unwrap(),
        nix::fcntl::FcntlArg::F_GETFL,
    )
    .unwrap();
    assert_eq!(flags & libc::O_ACCMODE, libc::O_RDONLY);
    assert!(owner.publish().is_err());
    owner.close().unwrap();
    assert!(owner.reference_data().is_err());
    assert!(
        version.is_file(),
        "checked metadata close never deletes the published input"
    );
}

#[test]
fn existing_version_or_symlink_is_never_overwritten_or_adopted_as_success() {
    for symbolic in [false, true] {
        let tree = Fixture::new();
        let mut owner = tree.owner();
        tree.create_versions();
        let target = tree.versions().join(&owner.filename);
        let existing = tree.root.join("existing-data");
        fs::write(&existing, b"preserved").unwrap();
        if symbolic {
            symlink(&existing, &target).unwrap();
        } else {
            fs::write(&target, b"preserved").unwrap();
        }
        let refused = owner.publish();
        let closed = owner.close();
        assert!(refused.is_err() && closed.is_ok());
        assert_eq!(fs::read(&target).unwrap(), b"preserved");
        assert_eq!(fs::read(existing).unwrap(), b"preserved");
    }
}

#[test]
fn directory_mode_or_rebinding_refuses_without_repair_or_cached_success() {
    let tree = Fixture::new();
    let mut owner = tree.owner();
    tree.create_versions();
    fs::set_permissions(tree.versions(), fs::Permissions::from_mode(0o777)).unwrap();
    assert!(owner.publish().is_err());
    owner.close().unwrap();
    assert_eq!(
        fs::metadata(tree.versions()).unwrap().mode() & 0o7777,
        0o777
    );
    let other = Fixture::new();
    let mut published = other.owner();
    published.publish().unwrap();
    fs::rename(other.versions(), other.root.join("original-versions")).unwrap();
    fs::create_dir(other.versions()).unwrap();
    fs::set_permissions(other.versions(), fs::Permissions::from_mode(0o750)).unwrap();
    assert!(published.assert_current().is_err());
    // Restoring the actual original name cannot erase the latched refusal.
    fs::remove_dir(other.versions()).unwrap();
    fs::rename(other.root.join("original-versions"), other.versions()).unwrap();
    assert_eq!(
        published.assert_current().unwrap_err().code(),
        "WORKER_POOL_PUBLICATION_CLOSED_OR_EXPIRED"
    );
    published.close().unwrap();
}

#[test]
fn consumed_writer_close_retains_reader_and_sticky_unknown_without_close_replay() {
    if fixture::isolated(
        "consumed_writer_close_retains_reader_and_sticky_unknown_without_close_replay",
    ) {
        return;
    }
    let tree = Fixture::new();
    let mut owner = tree.owner();
    native::test_faults::set(None, true);
    assert!(owner.publish().is_err());
    assert!(owner.writer.is_none() && owner.reader.is_some() && owner.close_unknown);
    assert!(owner.close().is_err());
    assert!(owner.reader.is_none());
    native::test_faults::set(None, true);
    assert!(owner.close().is_err());
    let sentinel = File::create(tree.root.join("new-sentinel")).unwrap();
    assert!(native::close(sentinel).unwrap_err().has_unconfirmed_close());
    native::test_faults::set(None, false);
}

#[test]
fn abandoned_publication_keeps_original_metadata_owners() {
    if fixture::isolated("abandoned_publication_keeps_original_metadata_owners") {
        return;
    }
    let tree = Fixture::new();
    let mut owner = tree.owner();
    owner.publish().unwrap();
    let mut originals = owner.directories.retained_stamps();
    let file = owner.reader.as_ref().unwrap();
    let info = file.metadata().unwrap();
    originals.push((file.as_raw_fd(), info.dev(), info.ino()));
    drop(owner);
    for (fd, dev, ino) in originals {
        let info = fs::metadata(format!("/proc/self/fd/{fd}")).unwrap();
        assert_eq!((info.dev(), info.ino()), (dev, ino));
    }
}

#[test]
fn original_deadline_and_production_instance_scope_refuse_before_file_effects() {
    use super::bootstrap::{RegisteredBirthSource, SourceKind};
    let tree = Fixture::new();
    let mut expired = tree.owner();
    expired.deadline = Instant::now() - Duration::from_nanos(1);
    assert!(expired.publish().is_err());
    assert!(!tree.root.join("worker-pool").exists());
    expired.close().unwrap();
    let data = tree.birth();
    let source = tree.root.join("worker.json");
    fs::write(&source, b"{}").unwrap();
    fs::set_permissions(&source, fs::Permissions::from_mode(0o600)).unwrap();
    let (selection, _) = RegisteredBirthSource::capture(&source, SourceKind::Installation).unwrap();
    assert_eq!(
        ControllerBirthPublication::unopened(
            &tree.runtime,
            data.into(),
            selection,
            Instant::now() + Duration::from_secs(5)
        )
        .err()
        .unwrap()
        .code(),
        "WORKER_POOL_PUBLICATION_INSTANCE"
    );
    assert!(!tree.root.join("worker-pool").exists());
}

#[test]
fn restored_birth_source_refuses_a_pending_control_transition() {
    use super::bootstrap::{RegisteredBirthSource, SourceKind};
    let tree = Fixture::new();
    let source = tree.root.join("worker.json");
    let state = tree.root.join("state");
    fs::create_dir(&state).unwrap();
    let raw = serde_json::to_vec(&serde_json::json!({
        "stateRoot":state,
        "resourceReservations":{"directory":tree.root.join("control")},
        "workerPoolProvider":{
            "version":2,"purpose":"reverie-docker-worker-pool-provider-v2",
            "policy":tree.birth().policy(),"memberRevision":7,"memberOverrides":{}
        }
    }))
    .unwrap();
    fs::write(&source, raw).unwrap();
    fs::set_permissions(&source, fs::Permissions::from_mode(0o600)).unwrap();
    let legacy = RegisteredBirthSource::capture(&source, SourceKind::Installation);
    assert_eq!(
        legacy.err().unwrap().code(),
        "WORKER_POOL_COMMITTED_BIRTH_REQUIRED"
    );
    let (original, configuration) =
        RegisteredBirthSource::capture(&source, SourceKind::Restoration).unwrap();
    let expected = reverie_contracts::worker_config::config_digest(&configuration);
    original.assert_expected_configuration(&expected).unwrap();
    let marker = state.join("resource-reservation-control.pending");
    fs::write(&marker, b"original pending record").unwrap();
    assert_eq!(
        original.assert_current().unwrap_err().code(),
        "WORKER_POOL_BIRTH_SOURCE_PENDING"
    );
    let reopened = RegisteredBirthSource::capture(&source, SourceKind::Restoration);
    assert_eq!(
        reopened.err().unwrap().code(),
        "WORKER_POOL_BIRTH_SOURCE_PENDING"
    );
    assert_eq!(fs::read(&marker).unwrap(), b"original pending record");
    fs::remove_file(marker).unwrap();
    original.assert_current().unwrap();

    // Keep the image and all other inputs fixed while an installed member
    // revision changes between the App load and the Host publication prefix.
    let mut changed: serde_json::Value =
        serde_json::from_slice(&fs::read(&source).unwrap()).unwrap();
    changed["workerPoolProvider"]["memberRevision"] = 8.into();
    fs::write(&source, serde_json::to_vec(&changed).unwrap()).unwrap();
    let (new, _) = RegisteredBirthSource::capture(&source, SourceKind::Restoration).unwrap();
    assert_eq!(
        new.assert_expected_configuration(&expected)
            .unwrap_err()
            .code(),
        "WORKER_POOL_BIRTH_SOURCE_CHANGED"
    );
    assert!(!tree.root.join("worker-pool").exists());
}
