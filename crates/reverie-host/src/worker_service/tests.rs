//! The bootstrap selector must refuse a live/foreign predecessor before any
//! selection write. The native capture fixture never invokes the user manager.
use super::*;
#[test]
fn installed_generation_must_be_inactive_and_exact_before_replacement() {
    let old = Path::new("/nix/store/old-worker/share/systemd/user/reverie-worker-broker.service");
    assert!(ObservedUnit::decode("LoadState=loaded\nActiveState=inactive\nSubState=dead\nFragmentPath=/nix/store/old-worker/share/systemd/user/reverie-worker-broker.service\n").unwrap().require_replaceable(Some(old)).is_ok());
    for raw in [
        "LoadState=loaded\nActiveState=active\nSubState=running\nFragmentPath=/nix/store/old-worker/share/systemd/user/reverie-worker-broker.service\n",
        "LoadState=loaded\nActiveState=inactive\nSubState=dead\nFragmentPath=/etc/systemd/user/foreign.service\n",
    ] {
        assert!(
            ObservedUnit::decode(raw)
                .unwrap()
                .require_replaceable(Some(old))
                .is_err()
        );
    }
    assert!(
        ObservedUnit::decode(
            "LoadState=not-found\nActiveState=inactive\nSubState=dead\nFragmentPath=\n"
        )
        .unwrap()
        .require_replaceable(None)
        .is_ok()
    );
}
#[test]
fn selection_environment_is_exact_and_cannot_inject_unit_directives() {
    assert_eq!(
        environment(Path::new("/home/owner/reverie/worker.json")).unwrap(),
        "REVERIE_WORKER_CONFIG=\"/home/owner/reverie/worker.json\"\n"
    );
    for value in [
        "relative",
        "/home/owner/reverie/a\nb",
        "/home/owner/reverie/a\rb",
    ] {
        assert!(environment(Path::new(value)).is_err());
    }
}
#[test]
fn actual_captured_active_manager_refuses_before_any_selection_write() {
    let (mut state, root, program) = fixture();
    let body = state.run(WorkerServiceAction::Install);
    let closed = state.close();
    assert!(matches!(
        body,
        Err(WorkerServiceError::Refused(
            "NATIVE_SERVICE_MUST_BE_INACTIVE"
        ))
    ));
    assert!(closed.is_ok());
    assert!(!state.folder().exists());
    assert!(state.last.as_ref().is_some_and(|out| out.2 == 0));
    fs::remove_file(program).unwrap();
    fs::remove_dir(root).unwrap();
}

#[test]
fn completed_job_requires_actual_action_specific_state() {
    let dead=ObservedUnit::decode("LoadState=loaded\nActiveState=inactive\nSubState=dead\nFragmentPath=/nix/store/known/unit\n").unwrap();
    assert!(
        dead.require_action_finished(&WorkerServiceAction::Stop)
            .is_ok()
    );
    assert!(
        dead.require_action_finished(&WorkerServiceAction::Start)
            .is_err()
    );
    let live=ObservedUnit::decode("LoadState=loaded\nActiveState=active\nSubState=running\nFragmentPath=/nix/store/known/unit\n").unwrap();
    assert!(
        live.require_action_finished(&WorkerServiceAction::Start)
            .is_ok()
    );
    assert!(
        live.require_action_finished(&WorkerServiceAction::Stop)
            .is_err()
    );
}

fn fixture() -> (State, PathBuf, PathBuf) {
    let root = std::env::temp_dir().join(format!(
        "native-worker-manager-{}-{}",
        std::process::id(),
        crate::resource_facts::fresh_owner_nonce().unwrap().as_str()
    ));
    fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
    let program = root.join("native-worker-manager");
    fs::hard_link(crate::engine_metadata::tests::program(), &program).unwrap();
    let command =
        InstalledCommand::from_snapshot(program.as_os_str(), Vec::new(), root.clone(), false)
            .unwrap();
    let state = State {
        home: root.clone(),
        root: root.clone(),
        source: root.join("worker.json"),
        unit: PathBuf::from(
            "/nix/store/new-worker/share/systemd/user/reverie-worker-broker.service",
        ),
        previous: Some(PathBuf::from(
            "/nix/store/old-worker/share/systemd/user/reverie-worker-broker.service",
        )),
        client: Arc::new(CapturedClient::new(command)),
        pin: Arc::new(CapturedClient::new(
            InstalledCommand::from_snapshot(program.as_os_str(), Vec::new(), root.clone(), false)
                .unwrap(),
        )),
        pin_call: None,
        call: None,
        files: Vec::new(),
        last: None,
        end: Instant::now() + Duration::from_secs(5),
        attempted: false,
        uncertain: false,
        marker: false,
        pending_identity: None,
    };

    (state, root, program)
}

#[test]
fn consumed_native_close_failure_remains_sticky_on_same_original_attempt() {
    let (mut state, root, program) = fixture();
    let folder = state.folder();
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&folder)
        .unwrap();
    state.begin_attempt(&WorkerServiceAction::Install).unwrap();
    native::test_faults::set(None, true);
    let primary = state.close().unwrap_err();
    assert!(state.uncertain);
    assert!(folder.join("pending").is_file());
    let mut failure = WorkerServiceFailure {
        owner: Some(Box::new(state)),
        primary,
    };
    assert!(failure.close_components().is_err());
    assert!(folder.join("pending").is_file());
    drop(failure);
    fs::remove_file(folder.join("pending")).unwrap();
    fs::remove_dir(&folder).unwrap();
    fs::remove_dir(root.join("worker-pool")).unwrap();
    fs::remove_file(program).unwrap();
    fs::remove_dir(root).unwrap();
}
#[test]
fn rollback_collision_never_replaces_history_or_moves_original_unit() {
    let root = std::env::temp_dir().join(format!(
        "native-unit-history-{}-{}",
        std::process::id(),
        crate::resource_facts::fresh_owner_nonce().unwrap().as_str()
    ));
    fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
    let from = root.join("units");
    let to = root.join("history");
    fs::DirBuilder::new().mode(0o700).create(&from).unwrap();
    fs::DirBuilder::new().mode(0o700).create(&to).unwrap();
    std::os::unix::fs::symlink("/nix/store/original/unit", from.join(UNIT)).unwrap();
    fs::write(to.join("previous-unit"), b"original rollback history").unwrap();
    let a = native::open_at(
        libc::AT_FDCWD,
        from.as_os_str(),
        libc::O_RDONLY | libc::O_DIRECTORY,
    )
    .unwrap();
    let b = native::open_at(
        libc::AT_FDCWD,
        to.as_os_str(),
        libc::O_RDONLY | libc::O_DIRECTORY,
    )
    .unwrap();
    assert_eq!(
        native::retain_predecessor(&a, &b).unwrap_err().kind(),
        std::io::ErrorKind::AlreadyExists
    );
    native::close(a).unwrap();
    native::close(b).unwrap();
    assert_eq!(
        fs::read_link(from.join(UNIT)).unwrap(),
        Path::new("/nix/store/original/unit")
    );
    assert_eq!(
        fs::read(to.join("previous-unit")).unwrap(),
        b"original rollback history"
    );
    fs::remove_file(from.join(UNIT)).unwrap();
    fs::remove_file(to.join("previous-unit")).unwrap();
    fs::remove_dir(from).unwrap();
    fs::remove_dir(to).unwrap();
    fs::remove_dir(root).unwrap();
}
