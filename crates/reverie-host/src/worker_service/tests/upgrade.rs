use super::*;
use std::os::unix::fs::PermissionsExt;
fn selection() -> (State, PathBuf, PathBuf, PathBuf) {
    selection_with_action(WorkerServiceAction::Upgrade {
        force_stopped: false,
    })
}
fn selection_with_action(action: WorkerServiceAction) -> (State, PathBuf, PathBuf, PathBuf) {
    let (mut state, root, program) = fixture_mode("native-worker-manager-rollback");
    state.root = root.join("reverie");
    state.source = state.root.join("worker.json");
    prepare_predecessor(&state);
    fs::create_dir_all(state.folder()).unwrap();
    fs::set_permissions(state.folder(), fs::Permissions::from_mode(0o700)).unwrap();
    let old =
        PathBuf::from("/nix/store/old-native/share/systemd/user/reverie-worker-broker.service");
    let link = state.home.join(".config/systemd/user").join(UNIT);
    fs::remove_file(&link).unwrap();
    std::os::unix::fs::symlink(&old, &link).unwrap();
    std::os::unix::fs::symlink(&old, state.folder().join("native-package")).unwrap();
    for name in [
        "source-original.json",
        "source-sha256",
        "previous-generation",
        "environment",
    ] {
        fs::write(state.folder().join(name), name.as_bytes()).unwrap();
        fs::set_permissions(state.folder().join(name), fs::Permissions::from_mode(0o600)).unwrap();
    }
    let history = state.folder().join("history");
    fs::DirBuilder::new().mode(0o700).create(&history).unwrap();
    state.begin_attempt(&action).unwrap();
    (state, root, program, history)
}
#[test]
fn replacement_keeps_original_history_configuration_and_both_old_native_links() {
    let (mut state, root, _, history) = selection();
    let old = fs::read_link(state.folder().join("native-package")).unwrap();
    let body = state.replace_native_links(&history, &old);
    let closed = state.close();
    assert!(body.is_ok(), "{body:?}");
    assert!(closed.is_ok());
    assert_eq!(
        fs::read_link(state.home.join(".config/systemd/user").join(UNIT)).unwrap(),
        state.unit
    );
    assert_eq!(
        fs::read_link(state.folder().join("native-package")).unwrap(),
        state.unit
    );
    assert_eq!(fs::read_link(history.join("previous-unit")).unwrap(), old);
    assert_eq!(
        fs::read_link(history.join("previous-native-package")).unwrap(),
        old
    );
    for name in [
        "source-original.json",
        "source-sha256",
        "previous-generation",
        "environment",
    ] {
        assert_eq!(
            fs::read(state.folder().join(name)).unwrap(),
            name.as_bytes()
        );
    }
    assert!(state.folder().join("pending").is_file());
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn history_collision_refuses_before_moving_original_unit_or_marker() {
    let (mut state, root, _, history) = selection();
    let old = fs::read_link(state.folder().join("native-package")).unwrap();
    fs::write(history.join("previous-unit"), b"original history").unwrap();
    assert!(state.replace_native_links(&history, &old).is_err());
    assert!(state.close().is_ok());
    assert_eq!(
        fs::read_link(state.home.join(".config/systemd/user").join(UNIT)).unwrap(),
        old
    );
    assert_eq!(
        fs::read(history.join("previous-unit")).unwrap(),
        b"original history"
    );
    assert!(state.folder().join("pending").is_file());
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn consumed_close_after_replacement_never_releases_original_upgrade_pending() {
    let (mut state, root, _, history) = selection();
    let old = fs::read_link(state.folder().join("native-package")).unwrap();
    state.replace_native_links(&history, &old).unwrap();
    native::test_faults::set(None, true);
    assert!(state.close().is_err());
    assert!(state.finish_attempt().is_err());
    assert!(state.folder().join("pending").is_file());
    native::test_faults::set(None, false);
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn forced_marker_archival_preserves_unknown_bytes_and_never_touches_resource_pending() {
    let (mut state, root, _, history) = selection();
    let resource = root.join("resource-reservation-control.pending");
    fs::write(&resource, b"original R unknown; no clear permission").unwrap();
    for name in ["native-running", "native-failure"] {
        fs::write(state.folder().join(name), name.as_bytes()).unwrap();
        fs::set_permissions(state.folder().join(name), fs::Permissions::from_mode(0o600)).unwrap();
    }
    state.archive_old_markers(&history).unwrap();
    assert!(state.close().is_ok());
    for name in ["native-running", "native-failure"] {
        assert_eq!(fs::read(history.join(name)).unwrap(), name.as_bytes());
        assert!(!state.folder().join(name).exists());
    }
    assert_eq!(
        fs::read(resource).unwrap(),
        b"original R unknown; no clear permission"
    );
    assert!(state.folder().join("pending").is_file());
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn never_running_stop_recovery_keeps_a_genuine_denial_until_upgrade_archives_it() {
    let (mut state, root, _, history) = selection_with_action(WorkerServiceAction::Stop);
    let pending = state.folder().join("pending");
    assert!(!state.folder().join("native-running").exists());
    let (barrier, _) = state.stop_recovery_denial_for_test().unwrap();
    assert_eq!(
        fs::read(&barrier).unwrap(),
        b"NATIVE_STOP_RECOVERY_DENIAL_V1\n"
    );
    assert!(crate::worker_service::failure_fence::assert_failure_absent(&barrier).is_err());
    assert_eq!(
        fs::read(&pending).unwrap(),
        pending_bytes(&WorkerServiceAction::Stop)
    );
    assert!(state.attempted && state.uncertain);
    state.archive_old_markers(&history).unwrap();
    assert_eq!(
        fs::read(history.join("native-failure")).unwrap(),
        b"NATIVE_STOP_RECOVERY_DENIAL_V1\n"
    );
    assert!(pending.is_file());
    assert_eq!(
        state.close().unwrap_err().code(),
        "NATIVE_SERVICE_ORIGINAL_EFFECT_RETAINED"
    );
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn racing_recovery_denial_never_overwrites_existing_history_or_releases_stop() {
    let (mut state, root, _, _) = selection_with_action(WorkerServiceAction::Stop);
    let pending = state.folder().join("pending");
    let barrier = state.folder().join("native-failure");
    fs::write(&barrier, b"earlier UNKNOWN record").unwrap();
    fs::set_permissions(&barrier, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(state.stop_recovery_denial_for_test().is_err());
    assert_eq!(fs::read(&barrier).unwrap(), b"earlier UNKNOWN record");
    assert_eq!(
        fs::read(pending).unwrap(),
        pending_bytes(&WorkerServiceAction::Stop)
    );
    assert!(state.attempted && state.uncertain);
    assert_eq!(
        state.close().unwrap_err().code(),
        "NATIVE_SERVICE_ORIGINAL_EFFECT_RETAINED"
    );
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn actual_original_bus_invocation_or_last_pid_drift_refuses_before_archival() {
    for changed in ["manager-invocation-changed", "manager-lastpid-changed"] {
        let (mut state, root, _, history) = selection();
        state.upgrade_bus =
            Some(crate::worker_service::stopped::bus::BusReader::controlled(&state).unwrap());
        let original = state.upgrade_bus.as_mut().unwrap().stopped_group().unwrap();
        fs::write(
            root.join(changed),
            b"same actual captured child now reports changed original",
        )
        .unwrap();
        assert!(state.assert_force_group_current(&original).is_err());
        assert!(state.close().is_ok());
        assert!(state.folder().join("pending").is_file());
        assert!(fs::read_dir(history).unwrap().next().is_none());
        fs::remove_dir_all(root).unwrap();
    }
}
#[test]
fn failed_unit_requires_explicit_upgrade_force_and_is_never_a_clean_stop_receipt() {
    let failed=ObservedUnit::decode("LoadState=loaded\nActiveState=failed\nSubState=failed\nFragmentPath=/nix/store/known/unit\nDropInPaths=\nNeedDaemonReload=no\n").unwrap();
    assert!(
        failed
            .require_action_finished(&WorkerServiceAction::Upgrade {
                force_stopped: true
            })
            .is_ok()
    );
    assert!(
        failed
            .require_action_finished(&WorkerServiceAction::Upgrade {
                force_stopped: false
            })
            .is_err()
    );
    assert!(
        failed
            .require_action_finished(&WorkerServiceAction::Stop)
            .is_err()
    );
    assert!(
        failed
            .require_action_finished(&WorkerServiceAction::Install)
            .is_err()
    );
}
#[test]
fn shared_error_is_send_sync_while_original_program_causes_stay_in_same_failure_owner() {
    fn send_sync<T: Send + Sync>() {}
    send_sync::<WorkerServiceError>();
    send_sync::<crate::worker_image::ImageFileError>();
    let (mut state, root, _, _) = selection();
    state.retain_program_error(crate::website_facts::WebsiteFactsError::Refused(
        "FIRST_ORIGINAL_CAUSE",
    ));
    let primary = state.retain_program_error(crate::website_facts::WebsiteFactsError::Refused(
        "SECOND_ORIGINAL_CAUSE",
    ));
    let mut failure = WorkerServiceFailure {
        owner: Some(Box::new(state)),
        primary,
    };
    match failure.program_error().unwrap() {
        crate::website_facts::WebsiteFactsError::Finalization { primary, secondary } => {
            assert_eq!(primary.code(), "FIRST_ORIGINAL_CAUSE");
            assert_eq!(secondary.code(), "SECOND_ORIGINAL_CAUSE");
        }
        _ => panic!("both original typed causes remain with the same owner"),
    }
    assert!(failure.close_components().is_ok());
    assert!(failure.program_error().is_some());
    assert!(
        std::error::Error::source(&failure)
            .unwrap()
            .downcast_ref::<crate::website_facts::WebsiteFactsError>()
            .is_some()
    );
    assert!(
        failure
            .owner
            .as_ref()
            .unwrap()
            .folder()
            .join("pending")
            .is_file()
    );
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn recorded_link_without_real_immutable_program_never_bypasses_generation_admission() {
    for action in [
        WorkerServiceAction::Status,
        WorkerServiceAction::Start,
        WorkerServiceAction::Stop,
        WorkerServiceAction::Install,
        WorkerServiceAction::Rollback {
            start_previous: false,
        },
    ] {
        let (mut state, root, _) = fixture_mode("native-worker-manager-rollback");
        prepare_predecessor(&state);
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(state.folder())
            .unwrap();
        let old = Path::new(
            "/nix/store/unqualified-native/share/systemd/user/reverie-worker-broker.service",
        );
        let link = state.home.join(".config/systemd/user").join(UNIT);
        fs::remove_file(&link).unwrap();
        std::os::unix::fs::symlink(old, &link).unwrap();
        std::os::unix::fs::symlink(old, state.folder().join("native-package")).unwrap();
        for name in [
            "previous-generation",
            "source-original.json",
            "source-sha256",
        ] {
            fs::write(state.folder().join(name), name).unwrap();
            fs::set_permissions(state.folder().join(name), fs::Permissions::from_mode(0o600))
                .unwrap();
        }
        let env = state.folder().join("environment");
        fs::write(&env, environment(&state.source).unwrap()).unwrap();
        fs::set_permissions(env, fs::Permissions::from_mode(0o600)).unwrap();
        fs::write(
            root.join("manager-fragment-link"),
            b"actual captured named fragment",
        )
        .unwrap();
        let body = state.run(action);
        let closed = state.close();
        assert!(body.is_err());
        assert!(closed.is_ok());
        assert!(state.checked_generation.is_none());
        assert!(!state.folder().join("pending").exists());
        assert!(!root.join("manager-stops").exists());
        assert_eq!(fs::read_link(link).unwrap(), old);
        fs::remove_dir_all(root).unwrap();
    }
}
#[test]
#[ignore = "explicit read-only qualification requires a built immutable native broker unit"]
fn checked_recorded_native_alias_is_readable_but_foreign_and_mutating_generations_refuse() {
    let old = PathBuf::from(
        std::env::var_os("REVERIE_TEST_NATIVE_UPGRADE_UNIT")
            .expect("actual immutable artifact required"),
    );
    let (mut state, root, _) = fixture_mode("native-worker-manager-rollback");
    prepare_predecessor(&state);
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(state.folder())
        .unwrap();
    let link = state.home.join(".config/systemd/user").join(UNIT);
    fs::remove_file(&link).unwrap();
    std::os::unix::fs::symlink(&old, &link).unwrap();
    std::os::unix::fs::symlink(&old, state.folder().join("native-package")).unwrap();
    for name in [
        "previous-generation",
        "source-original.json",
        "source-sha256",
    ] {
        fs::write(state.folder().join(name), name).unwrap();
        fs::set_permissions(state.folder().join(name), fs::Permissions::from_mode(0o600)).unwrap();
    }
    let env = state.folder().join("environment");
    fs::write(&env, environment(&state.source).unwrap()).unwrap();
    fs::set_permissions(env, fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(
        root.join("manager-fragment-link"),
        b"captured actual named fragment",
    )
    .unwrap();
    let status = state.run(WorkerServiceAction::Status);
    assert!(status.is_ok(), "{status:?}");
    let observed = state.observe().unwrap();
    assert_eq!(observed.fragment, old);
    assert!(state.assert_installed(&observed).is_err());
    assert!(state.assert_stoppable(&observed).is_err());
    fs::remove_file(&link).unwrap();
    std::os::unix::fs::symlink("/nix/store/foreign/unit", &link).unwrap();
    assert!(state.observe().is_err());
    assert!(state.close().is_ok());
    assert!(!state.folder().join("pending").exists());
    fs::remove_dir_all(root).unwrap();
}
