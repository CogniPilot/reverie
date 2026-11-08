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
    let mut state = State {
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
    };
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
