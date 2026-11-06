use super::*;

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
