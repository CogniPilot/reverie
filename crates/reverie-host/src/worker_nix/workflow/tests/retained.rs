use super::*;

#[test]
fn stale_plan_refuses_new_same_path_owner_after_actual_successful_nix_preparation() {
    if crate::test_process::isolate_case(
        "worker_nix::workflow::tests::retained::stale_plan_refuses_new_same_path_owner_after_actual_successful_nix_preparation",
    ) {
        return;
    }
    for employee in [false, true] {
        check_same_path_reacquisition(employee);
    }
}
fn acquire_storage(
    runtime: &WorkerRuntime,
    source: &EffectiveWorkerConfig,
    employee: bool,
) -> LaunchStorage {
    let selected = runtime
        .resolve_storage(source, &ProfileSessionId::parse(SID).unwrap())
        .unwrap();
    if employee {
        selected.acquire().unwrap()
    } else {
        selected.into_legacy().unwrap()
    }
}
fn check_same_path_reacquisition(employee: bool) {
    let tree = Tree::new();
    if employee {
        fs::write(tree.root.join("company.json"), serde_json::to_vec(&json!({"employees":[{
            "id":"11111111-2222-4333-8444-555555555555","sessionId":SID,"owner":null,"desiredRunning":true
        }]})).unwrap()).unwrap();
    }
    let runtime = tree.runtime("success", Hooks::default());
    let mut raw: serde_json::Value = serde_json::from_slice(
        &reverie_contracts::worker_config::encode_config(&tree.source('a')),
    )
    .unwrap();
    raw["apiSocketRoot"] = json!(tree.root.join("api"));
    raw["companyRoot"] = json!(tree.root.join("company"));
    let source =
        reverie_contracts::worker_config::decode(&serde_json::to_vec(&raw).unwrap()).unwrap();
    let sid = ProfileSessionId::parse(SID).unwrap();
    let mut a = acquire_storage(&runtime, &source, employee);
    a.prepare_storage().unwrap();
    a.record_storage_binding().unwrap();
    let plan_a = runtime
        .prepare_laptop_plan(source.clone(), source.clone(), &a)
        .unwrap();
    let original = a.paths().clone();
    plan_a.assert_storage_owner(&runtime, &a).unwrap();
    a.close(end()).unwrap();
    let b = acquire_storage(&runtime, &source, employee);
    let plan_b = runtime
        .prepare_laptop_plan(source.clone(), source.clone(), &b)
        .unwrap();
    let same_paths = b.paths() == &original;
    let guard = NixStoreGuard::acquire_launch(&source, &sid).unwrap();
    let workflow = runtime
        .retain_nix_store(guard, b, source)
        .unwrap_or_else(|_| panic!("retain real owner B"));
    let progress = runtime.run_nix_store(&workflow).unwrap();
    let capsule = runtime
        .reclaim_nix_store(workflow)
        .unwrap_or_else(|_| panic!("settled actual helper"));
    let stale = capsule.assert_create_plan(&runtime, &plan_a);
    let current = capsule.assert_create_plan(&runtime, &plan_b);
    let (guard, owner, outcome) = capsule.into_parts();
    let consumed_refused = if employee {
        native::test_faults::set(None, true);
        let (owner, _) = owner.close(end()).unwrap_err().into_parts();
        let refused = plan_b.assert_storage_owner(&runtime, &owner);
        guard.close().unwrap();
        matches!(
            refused,
            Err(crate::worker_launch::CreateObservationError::Owner(
                crate::worker_storage::StorageOwnerError::Refused(
                    "WORKER_STORAGE_CLOSE_UNCONFIRMED"
                )
            ))
        )
    } else {
        close_resources(guard, owner);
        true
    };
    runtime.close(end()).unwrap();
    assert!(same_paths);
    assert_eq!(progress, NixProgress::Prepared);
    assert_eq!(outcome.unwrap(), NixDisposition::Prepared);
    assert!(matches!(
        stale,
        Err(crate::worker_launch::CreateObservationError::StorageOwner)
    ));
    assert!(current.is_ok());
    assert!(
        consumed_refused,
        "the same token cannot revive a consumed-unconfirmed owner"
    );
    assert_eq!(
        count(&tree, "create"),
        1,
        "only the real Nix helper was created"
    );
}

#[test]
fn unknown_create_and_failed_remove_keep_actual_guards_and_never_replay_effects() {
    for mode in ["unknown-create", "rm-failure"] {
        let tree = Tree::new();
        let runtime = tree.runtime(mode, Hooks::default());
        let workflow = tree.retain(&runtime, 'a');
        assert_eq!(
            runtime.run_nix_store(&workflow).unwrap(),
            NixProgress::Retained
        );
        let error = runtime.reclaim_nix_store(workflow.clone()).err().unwrap();
        let (retained, _) = error.into_parts();
        assert!(retained.same_workflow(&workflow));
        assert!(NixStoreGuard::acquire_migration(&tree.source('a'), workflow.session()).is_err());
        assert!(runtime.run_nix_store(&workflow).is_err());
        assert!(runtime.close(end()).is_err());
        assert!(runtime.close(end()).is_err());
        assert_eq!(count(&tree, "create"), 1);
        assert_eq!(count(&tree, "rm"), usize::from(mode == "rm-failure"));
    }
}

#[test]
fn legacy_opt_out_finishes_while_an_unknown_helper_keeps_the_actual_global_turn() {
    let tree = Tree::new();
    let runtime = Arc::new(tree.runtime("unknown-create", Hooks::default()));
    let unknown = tree.retain(&runtime, 'a');
    assert_eq!(
        runtime.run_nix_store(&unknown).unwrap(),
        NixProgress::Retained
    );
    let legacy = tree.retain_session(&runtime, 'b', "11111111-2222-4333-8444-555555555555");
    let alias = legacy.clone();
    let other = runtime.clone();
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    let task = std::thread::spawn(move || {
        let result = other.run_nix_store(&alias);
        send.send(result).unwrap();
    });
    let result = receive.recv_timeout(Duration::from_secs(2));
    if result.is_err() {
        runtime.request_stop();
    }
    task.join().unwrap();
    assert_eq!(result.unwrap().unwrap(), NixProgress::NoHelper);
    let (guard, storage, result) = returned(&runtime, legacy);
    assert_eq!(result.unwrap(), NixDisposition::NoHelper);
    close_resources(guard, storage);
    assert_eq!(count(&tree, "create"), 1);
    assert!(runtime.close(end()).is_err());
}

#[test]
fn removal_finalizer_failure_retains_resources_even_if_the_owned_counterpart_reports_removed() {
    let tree = Tree::new();
    let hooks = Hooks::default();
    let fault = hooks.close_failed.clone();
    let runtime = Arc::new(tree.runtime("rm-finalizer", hooks));
    let workflow = tree.retain(&runtime, 'a');
    let other = runtime.clone();
    let handle = workflow.clone();
    let task = std::thread::spawn(move || other.run_nix_store(&handle));
    tree.wait("rm-entered");
    fault.store(true, Ordering::Release);
    fs::write(tree.root.join("release-rm"), b"owned").unwrap();
    assert_eq!(task.join().unwrap().unwrap(), NixProgress::Retained);
    assert!(tree.root.join("removed").exists());
    assert!(runtime.reclaim_nix_store(workflow).is_err());
    assert!(runtime.close(end()).is_err());
    assert_eq!(count(&tree, "rm"), 1);
}

#[test]
fn unused_retained_records_are_cancelled_before_service_sealing_and_return_original_owners() {
    let tree = Tree::new();
    let runtime = tree.runtime("success", Hooks::default());
    let workflow = tree.retain(&runtime, 'a');
    assert!(tree.trace().is_empty());
    runtime.close(end()).unwrap();
    assert!(tree.trace().is_empty());
    let (guard, storage, result) = returned(&runtime, workflow);
    assert!(result.is_err());
    close_resources(guard, storage);
}

#[test]
fn capacity_is_captured_once_and_a_rejected_slot_returns_the_live_original_resources() {
    let tree = Tree::new();
    let runtime = tree.runtime("success", Hooks::default());
    let mut handles = Vec::new();
    for index in 0..runtime.connection_limit() {
        let session = format!("{index:08x}-0000-0000-0000-000000000000");
        handles.push(tree.retain_session(&runtime, 'a', &session));
    }
    let source = tree.source('a');
    let sid = ProfileSessionId::parse(SID).unwrap();
    let storage = runtime
        .resolve_storage(&source, &sid)
        .unwrap()
        .into_legacy()
        .unwrap();
    let guard = NixStoreGuard::acquire_launch(&source, &sid).unwrap();
    let (guard, storage, _) = runtime
        .retain_nix_store(guard, storage, source.clone())
        .err()
        .unwrap()
        .into_parts();
    assert!(NixStoreGuard::acquire_migration(&source, &sid).is_err());
    close_resources(guard, storage);
    runtime.close(end()).unwrap();
    for handle in handles {
        let (guard, storage, result) = returned(&runtime, handle);
        assert!(result.is_err());
        close_resources(guard, storage);
    }
    assert!(tree.trace().is_empty());
}

#[test]
fn legacy_opt_out_observes_no_fresh_guard_or_storage_path_after_pure_retention() {
    let tree = Tree::new();
    let runtime = tree.runtime("success", Hooks::default());
    let workflow = tree.retain(&runtime, 'b');
    let original = tree.root.join("state").join(SID);
    let moved = tree.root.join("kept-original");
    fs::rename(&original, &moved).unwrap();
    fs::create_dir(&original).unwrap();
    fs::set_permissions(&original, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(original.join("foreign"), b"do-not-change").unwrap();
    assert_eq!(
        runtime.run_nix_store(&workflow).unwrap(),
        NixProgress::NoHelper
    );
    let (guard, storage, result) = returned(&runtime, workflow);
    assert_eq!(result.unwrap(), NixDisposition::NoHelper);
    assert!(guard.close().is_err());
    storage.close(end()).unwrap();
    runtime.close(end()).unwrap();
    assert_eq!(
        fs::read(original.join("foreign")).unwrap(),
        b"do-not-change"
    );
    assert_eq!(count(&tree, "image"), 1);
    assert_eq!(count(&tree, "create"), 0);
}

#[test]
fn first_service_stop_keeps_cleanup_on_the_same_context_before_permanent_sealing() {
    let tree = Tree::new();
    let runtime = Arc::new(tree.runtime("running", Hooks::default()));
    let workflow = tree.retain(&runtime, 'a');
    let gate = Arc::new(crate::captured_client::test_hooks::Gate::default());
    workflow.record.lock().unwrap().after_running_state = Some(gate.clone());
    let handle = workflow.clone();
    let other = runtime.clone();
    let task = std::thread::spawn(move || other.run_nix_store(&handle));
    let ceiling = Instant::now() + Duration::from_secs(10);
    while !gate.entered.load(Ordering::Acquire) {
        assert!(
            Instant::now() < ceiling,
            "owning setup observes a fully checked running-state call"
        );
        std::thread::sleep(Duration::from_millis(1));
    }
    let first = runtime.request_stop();
    let repeated = runtime.request_stop();
    let initial = runtime.close(end());
    gate.released.store(true, Ordering::Release);
    let progress = task.join().unwrap().unwrap();
    runtime.close(end()).unwrap();
    let (guard, storage, result) = returned(&runtime, workflow);
    close_resources(guard, storage);
    eprintln!(
        "checked-state stop: initial_close_error={} progress={progress:?} logs={} rm={} removed={}",
        initial.is_err(),
        count(&tree, "logs"),
        count(&tree, "rm"),
        tree.root.join("removed").exists()
    );
    assert!(
        initial.is_err(),
        "the actual workflow still owns its record"
    );
    assert_eq!(progress, NixProgress::Rejected);
    assert_eq!(count(&tree, "logs"), 1);
    assert_eq!(count(&tree, "rm"), 1);
    assert!(tree.root.join("removed").exists());
    assert_eq!(runtime.stop_deadline(), Some(first));
    assert_eq!(repeated, first);
    assert!(result.is_err());
}

#[test]
fn concurrent_close_during_dispatched_removal_retains_unknown_and_never_replays_rm() {
    let tree = Tree::new();
    let runtime = Arc::new(tree.runtime("rm-finalizer", Hooks::default()));
    let workflow = tree.retain(&runtime, 'a');
    let alias = workflow.clone();
    let other = runtime.clone();
    let task = std::thread::spawn(move || other.run_nix_store(&alias));
    tree.wait("rm-entered");
    let first = runtime.request_stop();
    let initial = runtime.close(end());
    let progress = task.join().unwrap().unwrap();
    let final_close = runtime.close(end());
    let failed = runtime.reclaim_nix_store(workflow.clone()).err().unwrap();
    let retained = failed.into_parts().0;
    let record = retained.record.lock().unwrap();
    eprintln!(
        "dispatched-removal stop: initial_close_error={} final_close_error={} progress={progress:?} unknown_effect={} pending_call={} logs={} rm={} removed={}",
        initial.is_err(),
        final_close.is_err(),
        record.unknown_effect,
        record.pending_call.is_some(),
        count(&tree, "logs"),
        count(&tree, "rm"),
        tree.root.join("removed").exists()
    );
    drop(record);
    assert!(retained.same_workflow(&workflow));
    assert!(initial.is_err() && final_close.is_err());
    assert_eq!(progress, NixProgress::Retained);
    assert_eq!(runtime.stop_deadline(), Some(first));
    assert_eq!(count(&tree, "logs"), 1);
    assert_eq!(count(&tree, "rm"), 1);
    assert!(!tree.root.join("removed").exists());
    assert!(NixStoreGuard::acquire_migration(&tree.source('a'), workflow.session()).is_err());
}

#[test]
fn successful_return_keeps_exact_helper_store_when_later_rollback_selection_changes() {
    let tree = Tree::new();
    let runtime = tree.runtime("success", Hooks::default());
    let workflow = tree.retain(&runtime, 'a');
    let progress = runtime.run_nix_store(&workflow).unwrap();
    let reference: serde_json::Value =
        serde_json::from_str(include_str!("../../fixtures/prepared-path-return.json")).unwrap();
    let expected = PathBuf::from(
        reference["returned"]
            .as_str()
            .unwrap()
            .replace("$ROOT", tree.root.to_str().unwrap()),
    );
    let expected_later = PathBuf::from(
        reference["laterLookup"]
            .as_str()
            .unwrap()
            .replace("$ROOT", tree.root.to_str().unwrap()),
    );
    let marker = tree.root.join("state").join(SID).join("nix-rollback.json");
    fs::write(
        &marker,
        serde_json::to_vec(&json!({"version":1,"sessionId":SID,"legacy":true})).unwrap(),
    )
    .unwrap();
    fs::set_permissions(&marker, fs::Permissions::from_mode(0o600)).unwrap();
    let returned = runtime
        .reclaim_nix_store(workflow)
        .unwrap_or_else(|_| panic!("settled helper must return owners"));
    let actual = returned.prepared_path().unwrap().to_owned();
    let (guard, storage, outcome) = returned.into_parts();
    let later = guard.selected_path().unwrap();
    close_resources(guard, storage);
    runtime.close(end()).unwrap();
    assert_eq!(progress, NixProgress::Prepared);
    assert_eq!(outcome.unwrap(), NixDisposition::Prepared);
    assert_eq!(actual, expected);
    assert_eq!(later, expected_later);
    assert_ne!(
        actual, later,
        "a fresh lookup would mount a different store than the helper prepared"
    );
    assert_eq!(count(&tree, "create"), 1);
    assert_eq!(count(&tree, "rm"), 1);
}

#[test]
fn noop_and_known_negative_never_return_a_prepared_store_path() {
    for (mode, image, expected) in [
        ("success", 'b', NixProgress::NoHelper),
        ("helper-failed", 'a', NixProgress::Rejected),
    ] {
        let tree = Tree::new();
        let runtime = tree.runtime(mode, Hooks::default());
        let workflow = tree.retain(&runtime, image);
        let progress = runtime.run_nix_store(&workflow).unwrap();
        let returned = runtime
            .reclaim_nix_store(workflow)
            .unwrap_or_else(|_| panic!("known result must return exact owners"));
        let has_path = returned.prepared_path().is_some();
        let (guard, storage, outcome) = returned.into_parts();
        close_resources(guard, storage);
        runtime.close(end()).unwrap();
        assert_eq!(progress, expected);
        assert!(!has_path);
        assert_eq!(outcome.is_err(), mode == "helper-failed");
    }
}
