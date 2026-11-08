//! The bootstrap selector must refuse a live/foreign predecessor before any
//! selection write. The native capture fixture never invokes the user manager.
#[path = "tests/fragment.rs"]
mod fragment;
use super::*;
#[path = "tests/image_rollback.rs"]
mod image_rollback;
mod stopped;
#[test]
fn installed_generation_must_be_inactive_and_exact_before_replacement() {
    let old = Path::new("/nix/store/old-worker/share/systemd/user/reverie-worker-broker.service");
    assert!(ObservedUnit::decode("LoadState=loaded\nActiveState=inactive\nSubState=dead\nFragmentPath=/nix/store/old-worker/share/systemd/user/reverie-worker-broker.service\nDropInPaths=\nNeedDaemonReload=no\n").unwrap().require_replaceable(Some(old)).is_ok());
    for raw in [
        "LoadState=loaded\nActiveState=active\nSubState=running\nFragmentPath=/nix/store/old-worker/share/systemd/user/reverie-worker-broker.service\nDropInPaths=\nNeedDaemonReload=no\n",
        "LoadState=loaded\nActiveState=inactive\nSubState=dead\nFragmentPath=/etc/systemd/user/foreign.service\nDropInPaths=\nNeedDaemonReload=no\n",
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
            "LoadState=not-found\nActiveState=inactive\nSubState=dead\nFragmentPath=\nDropInPaths=\nNeedDaemonReload=no\n"
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
    let dead=ObservedUnit::decode("LoadState=loaded\nActiveState=inactive\nSubState=dead\nFragmentPath=/nix/store/known/unit\nDropInPaths=\nNeedDaemonReload=no\n").unwrap();
    assert!(
        dead.require_action_finished(&WorkerServiceAction::Stop)
            .is_ok()
    );
    assert!(
        dead.require_action_finished(&WorkerServiceAction::Start)
            .is_err()
    );
    let live=ObservedUnit::decode("LoadState=loaded\nActiveState=active\nSubState=running\nFragmentPath=/nix/store/known/unit\nDropInPaths=\nNeedDaemonReload=no\n").unwrap();
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
    fixture_mode("native-worker-manager")
}
fn fixture_mode(mode: &str) -> (State, PathBuf, PathBuf) {
    assert!(matches!(
        mode,
        "native-worker-manager"
            | "native-worker-manager-legacy"
            | "native-worker-manager-slow"
            | "native-worker-manager-rollback"
    ));
    let root = std::env::temp_dir().join(format!(
        "native-worker-manager-{}-{}",
        std::process::id(),
        crate::resource_facts::fresh_owner_nonce().unwrap().as_str()
    ));
    fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
    let program = root.join(mode);
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

#[test]
fn actual_known_predecessor_stop_uses_only_original_unit_and_preserves_generation() {
    let (mut state, root, program) = fixture_mode("native-worker-manager-legacy");
    prepare_predecessor(&state);
    let result = state.run(WorkerServiceAction::Stop);
    let closed = state.close();
    let trace = fs::read(root.join("manager-stops"));
    let generation = fs::read_link(root.join(".config/systemd/user").join(UNIT));
    let previous = state.previous.clone();
    let finished = if result.is_ok() && closed.is_ok() {
        state.finish_attempt()
    } else {
        Ok(())
    };
    cleanup_predecessor(root, program);
    assert!(closed.is_ok());
    assert!(result.is_ok(), "{result:?}");
    assert!(finished.is_ok());
    assert_eq!(trace.unwrap(), b"original-stop\n");
    assert_eq!(generation.unwrap(), previous.unwrap());
}
fn prepare_predecessor(state: &State) {
    for path in [
        state.home.join(".config/systemd/user"),
        state.home.join(".config/reverie"),
    ] {
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(path)
            .unwrap();
    }
    std::os::unix::fs::symlink(
        state.previous.as_ref().unwrap(),
        state.home.join(".config/systemd/user").join(UNIT),
    )
    .unwrap();
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(state.home.join(".config/reverie/worker-broker.env"))
        .unwrap();
    file.write_all(environment(&state.source).unwrap().as_bytes())
        .unwrap();
    file.sync_all().unwrap();
    native::close(file).unwrap();
}
fn cleanup_predecessor(root: PathBuf, program: PathBuf) {
    fs::remove_file(root.join(".config/systemd/user").join(UNIT)).unwrap();
    fs::remove_file(root.join(".config/reverie/worker-broker.env")).unwrap();
    for path in ["manager-stops", "manager-stopped"] {
        if root.join(path).exists() {
            fs::remove_file(root.join(path)).unwrap();
        }
    }
    for path in [
        ".config/systemd/user",
        ".config/systemd",
        ".config/reverie",
        ".config",
        "worker-pool/service",
        "worker-pool",
    ] {
        if root.join(path).is_dir() {
            fs::remove_dir(root.join(path)).unwrap();
        }
    }
    fs::remove_file(program).unwrap();
    fs::remove_dir(root).unwrap();
}
#[test]
fn actual_packaged_alias_keeps_nix_store_argv0_dispatch() {
    let target = std::env::split_paths(&std::env::var_os("PATH").unwrap())
        .filter_map(|directory| fs::canonicalize(directory.join("nix-store")).ok())
        .find(|path| {
            path.starts_with("/nix/store") && path.file_name().is_some_and(|name| name == "nix")
        })
        .expect("qualified Nix development environment required");
    let alias = target.with_file_name("nix-store");
    assert_ne!(alias, alias.canonicalize().unwrap());
    immutable_tool(&alias).unwrap();
    let root = std::env::temp_dir().join(format!(
        "native-alias-{}-{}",
        std::process::id(),
        crate::resource_facts::fresh_owner_nonce().unwrap().as_str()
    ));
    fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
    let untrusted = root.join("nix-store");
    std::os::unix::fs::symlink(&alias, &untrusted).unwrap();
    assert!(immutable_tool(&untrusted).is_err());
    let command =
        InstalledCommand::from_snapshot(alias.as_os_str(), Vec::new(), root.clone(), false)
            .unwrap();
    let client = CapturedClient::new(command);
    let end = Instant::now() + Duration::from_secs(5);
    let output = client.run_scoped(
        vec!["--version".into()],
        end,
        &CancellationToken::new(),
        Policy {
            maximum: Duration::from_secs(3),
            maximum_output: 65536,
            successful_exit: true,
        },
    );
    let close = client.close(end);
    assert!(close.is_ok());
    let output = match output {
        Ok(output) => output,
        Err(failure) => {
            let error = format!("{:?}", failure.error);
            std::mem::forget(failure);
            panic!("{error}")
        }
    };
    assert!(
        String::from_utf8(output.stdout)
            .unwrap()
            .starts_with("nix-store (Nix) ")
    );
    fs::remove_file(untrusted).unwrap();
    fs::remove_dir(root).unwrap();
}
#[test]
fn actual_slow_predecessor_stop_keeps_original_end_pending_and_single_attempt() {
    let (mut state, root, program) = fixture_mode("native-worker-manager-slow");
    prepare_predecessor(&state);
    let end = Instant::now() + Duration::from_millis(500);
    state.end = end;
    let body = state.run(WorkerServiceAction::Stop);
    std::thread::sleep(Duration::from_millis(1800));
    let close = state.close();
    let trace = fs::read(root.join("manager-stops"));
    let original_end = state.end;
    let uncertain = state.uncertain;
    let pending = state.folder().join("pending");
    let pending_retained = pending.is_file();
    if state.call.is_some() || state.pin_call.is_some() || !state.files.is_empty() {
        eprintln!("retained original controlled fixture: {}", root.display());
        std::mem::forget(state);
        panic!("original controlled native owner did not settle");
    }
    if pending_retained {
        fs::remove_file(pending).unwrap();
    }
    cleanup_predecessor(root, program);
    assert!(body.is_err());
    assert!(close.is_err());
    assert!(uncertain && pending_retained);
    assert_eq!(original_end, end);
    assert_eq!(trace.unwrap(), b"original-stop\n");
}

#[test]
fn actual_happy_path_rollback_preserves_native_artifacts_and_restores_only_previous() {
    let (mut state, root, _program) = rollback_fixture();
    let native = state.unit.clone();
    let previous = state.previous.clone().unwrap();
    let source = state.source.clone();
    let body = state.run(WorkerServiceAction::Rollback {
        start_previous: false,
    });
    let closed = state.close();
    let finish = if body.is_ok() && closed.is_ok() {
        state.finish_attempt()
    } else {
        Ok(())
    };
    let current = fs::read_link(root.join(".config/systemd/user").join(UNIT));
    let retained = fs::read_link(state.folder().join("rolled-back-native-unit"));
    let env = fs::read_to_string(state.folder().join("rolled-back-native-environment"));
    let pending = state.folder().join("pending").exists();
    assert!(closed.is_ok(), "{closed:?}");
    fs::remove_dir_all(root).unwrap();
    assert!(body.is_ok(), "{body:?}");
    assert!(finish.is_ok());
    assert_eq!(current.unwrap(), previous);
    assert_eq!(retained.unwrap(), native);
    assert_eq!(env.unwrap(), environment(&source).unwrap());
    assert!(!pending);
}
#[test]
fn actual_rollback_rejects_unsettled_run_and_changed_source_before_unit_move() {
    let (mut state, root, _program) = rollback_fixture();
    let current = state.home.join(".config/systemd/user").join(UNIT);
    let native = state.unit.clone();
    write_owned_test(
        &state.folder().join("native-running"),
        b"original native custody",
    );
    let running = state.run(WorkerServiceAction::Rollback {
        start_previous: false,
    });
    fs::remove_file(state.folder().join("native-running")).unwrap();
    fs::write(&state.source, b"changed original selection").unwrap();
    let changed = state.run(WorkerServiceAction::Rollback {
        start_previous: false,
    });
    let closed = state.close();
    let unchanged =
        fs::read_link(current).unwrap() == native && !state.folder().join("pending").exists();
    assert!(closed.is_ok());
    fs::remove_dir_all(root).unwrap();
    assert!(matches!(
        running,
        Err(WorkerServiceError::Refused(
            "NATIVE_SERVICE_ROLLBACK_REQUIRES_QUIESCENCE"
        ))
    ));
    assert!(matches!(
        changed,
        Err(WorkerServiceError::Refused(
            "NATIVE_SERVICE_ROLLBACK_SOURCE_CHANGED"
        ))
    ));
    assert!(unchanged);
}
#[test]
fn actual_rollback_starts_previous_only_when_explicitly_selected() {
    let (mut state, root, _program) = rollback_fixture();
    let body = state.run(WorkerServiceAction::Rollback {
        start_previous: true,
    });
    let closed = state.close();
    let finish = if body.is_ok() && closed.is_ok() {
        state.finish_attempt()
    } else {
        Ok(())
    };
    let started = root.join("manager-started").is_file();
    assert!(closed.is_ok());
    fs::remove_dir_all(root).unwrap();
    assert!(body.is_ok(), "{body:?}");
    assert!(finish.is_ok());
    assert!(started);
}
pub(super) fn rollback_fixture() -> (State, PathBuf, PathBuf) {
    use sha2::Digest;
    let (state, root, program) = fixture_mode("native-worker-manager-rollback");
    prepare_predecessor(&state);
    fs::remove_file(state.home.join(".config/systemd/user").join(UNIT)).unwrap();
    std::os::unix::fs::symlink(
        &state.unit,
        state.home.join(".config/systemd/user").join(UNIT),
    )
    .unwrap();
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(state.folder())
        .unwrap();
    write_owned_test(&state.source, b"{\"owned\":\"bootstrap fixture\"}\n");
    write_owned_test(
        &state.folder().join("environment"),
        environment(&state.source).unwrap().as_bytes(),
    );
    write_owned_test(
        &state.folder().join("previous-generation"),
        state
            .previous
            .as_ref()
            .unwrap()
            .as_os_str()
            .as_encoded_bytes(),
    );
    std::os::unix::fs::symlink(
        state.previous.as_ref().unwrap(),
        state.folder().join("previous-unit"),
    )
    .unwrap();
    let digest = format!(
        "{:x}",
        sha2::Sha256::digest(fs::read(&state.source).unwrap())
    );
    write_owned_test(&state.folder().join("source-sha256"), digest.as_bytes());
    (state, root, program)
}
fn write_owned_test(path: &Path, bytes: &[u8]) {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .unwrap();
    file.write_all(bytes).unwrap();
    file.sync_all().unwrap();
    native::close(file).unwrap();
}
#[test]
fn effective_unit_dropins_cannot_hide_behind_unchanged_packaged_fragment() {
    let unchanged = "LoadState=loaded\nActiveState=inactive\nSubState=dead\nFragmentPath=/nix/store/known/unit\nDropInPaths=\nNeedDaemonReload=no\n";
    assert!(ObservedUnit::decode(unchanged).is_ok());
    let overridden = unchanged.replace(
        "DropInPaths=\n",
        "DropInPaths=/owner/.config/systemd/user/reverie-worker-broker.service.d/override.conf\n",
    );
    assert!(matches!(
        ObservedUnit::decode(&overridden),
        Err(WorkerServiceError::Refused(
            "NATIVE_SERVICE_DROPIN_OVERRIDE_REFUSED"
        ))
    ));
}
