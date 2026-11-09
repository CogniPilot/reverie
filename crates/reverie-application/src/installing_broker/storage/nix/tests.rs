use super::super::nix::{NixStorageError, NixStoragePreparation};
use super::*;
use reverie_host::worker_nix::{NixDisposition, NixProgress, NixStoreGuard};
use std::{path::Path, process::Command, sync::OnceLock};
fn nix_program() -> &'static Path {
    static PROGRAM: OnceLock<PathBuf> = OnceLock::new();
    PROGRAM.get_or_init(|| {
        let root = crate::test_process::fixture_directory("reverie-application-nix-program");
        let source = root.join("child.rs");
        fs::write(
            &source,
            include_str!("../../../../../reverie-host/tests/support/nix_workflow_child.rs"),
        )
        .unwrap();
        let binary = root.join("engine");
        assert!(
            Command::new("rustc")
                .arg("--edition=2024")
                .arg(&source)
                .arg("-o")
                .arg(&binary)
                .status()
                .unwrap()
                .success()
        );
        binary
    })
}
fn registry(tree: &Tree, mode: &str) -> Arc<StorageRegistry> {
    // The shared Host fixture deliberately pauses metadata clients by default.
    // These cases exercise helper custody, not that separate admission gate.
    tree.write("release-metadata", b"metadata census may finish");
    tree.registry_with(
        nix_program(),
        BTreeMap::from([("NIX_FIXTURE_MODE".into(), mode.into())]),
    )
}
fn source(tree: &Tree, image: char) -> EffectiveWorkerConfig {
    let mut raw: serde_json::Value =
        serde_json::from_slice(&worker_config::encode_config(&tree.source())).unwrap();
    for (key, value) in [
        ("budgetMode", json!("admission")),
        ("memoryMiB", json!(1024)),
        ("pidsLimit", json!(128)),
        ("cpus", json!(1)),
        ("poolMemoryMiB", json!(8192)),
        ("poolTasksMax", json!(512)),
        (
            "image",
            json!(format!("sha256:{}", image.to_string().repeat(64))),
        ),
    ] {
        raw[key] = value;
    }
    worker_config::decode(&serde_json::to_vec(&raw).unwrap()).unwrap()
}
fn claim(tree: &Tree, registry: &Arc<StorageRegistry>, image: char) -> StorageClaim {
    let mut claim = registry.claim(&source(tree, image), &sid(SID)).unwrap();
    claim.prepare_storage().unwrap();
    claim.record_storage_binding().unwrap();
    claim
}
fn retain(tree: &Tree, claim: StorageClaim, image: char) -> NixStoragePreparation {
    let raw = source(tree, image);
    let guard = NixStoreGuard::acquire_launch(&raw, &sid(SID)).unwrap();
    claim.retain_nix(guard, raw).unwrap()
}
fn trace(tree: &Tree, command: &str) -> usize {
    fs::read_to_string(tree.0.join("trace"))
        .unwrap_or_default()
        .lines()
        .filter(|line| line.split('\0').next() == Some(command))
        .count()
}
fn finish(preparation: NixStoragePreparation) -> (StoragePaths, NixDisposition) {
    let (claim, guard, result) = preparation.reclaim().unwrap().into_parts();
    let paths = claim.paths().clone();
    guard.close().unwrap();
    claim.release(end()).unwrap();
    (paths, result.unwrap())
}
#[test]
fn genuine_legacy_nix_handoff_never_invents_an_employee_entry_or_lease() {
    crate::test_process::owning_case!(
        genuine_legacy_nix_handoff_never_invents_an_employee_entry_or_lease
    );
    let tree = Tree::new();
    tree.write("company.json", br#"{"employees":[]}"#);
    let registry = registry(&tree, "");
    let claim = claim(&tree, &registry, 'b');
    let paths = claim.paths().clone();
    let preparation = retain(&tree, claim, 'b');
    let held = registry.entries.lock().unwrap();
    let progress = preparation.run().unwrap();
    drop(held);
    let (returned, outcome) = finish(preparation);
    registry.runtime.close(end()).unwrap();
    assert_eq!(progress, NixProgress::NoHelper);
    assert_eq!(outcome, NixDisposition::NoHelper);
    assert_eq!(paths, returned);
    assert!(registry.entries.lock().unwrap().is_empty());
    assert!(!tree.0.join("state/storage-locks").exists());
    assert_eq!(trace(&tree, "image"), 1);
    assert_eq!(trace(&tree, "create"), 0);
}
#[test]
fn employee_transfer_fences_every_direct_alias_then_restores_the_same_actual_owner() {
    crate::test_process::owning_case!(
        employee_transfer_fences_every_direct_alias_then_restores_the_same_actual_owner
    );
    let tree = Tree::new();
    let registry = registry(&tree, "");
    let claim = claim(&tree, &registry, 'b');
    let paths = claim.paths().clone();
    // Same selected employee claim aliases are real existing service handles,
    // not manufactured identity/path/status permissions.
    let alias = registry.claim(&source(&tree, 'b'), &sid(SID)).unwrap();
    let preparation = retain(&tree, claim, 'b');
    let (mut alias, released) = alias.release(end()).unwrap_err().into_parts();
    let preparation_error = alias.prepare_storage().unwrap_err();
    let claim_error = registry
        .claim(&source(&tree, 'b'), &sid(SID))
        .err()
        .unwrap();
    let progress = preparation.run().unwrap();
    let (returned, outcome) = finish(preparation);
    alias.release(end()).unwrap();
    registry.runtime.close(end()).unwrap();
    assert_eq!(released.code(), "WORKER_NIX_STORAGE_RETAINED");
    assert_eq!(preparation_error.code(), "WORKER_NIX_STORAGE_RETAINED");
    assert_eq!(claim_error.code(), "WORKER_STORAGE_CLEANUP_UNCONFIRMED");
    assert_eq!(progress, NixProgress::NoHelper);
    assert_eq!(outcome, NixDisposition::NoHelper);
    assert_eq!(paths, returned);
    assert!(registry.entries.lock().unwrap().is_empty());
}
#[test]
fn actual_fixed_helper_flow_returns_owners_only_after_checked_removal_and_settlement() {
    crate::test_process::owning_case!(
        actual_fixed_helper_flow_returns_owners_only_after_checked_removal_and_settlement
    );
    let tree = Tree::new();
    let registry = registry(&tree, "");
    let claim = claim(&tree, &registry, 'a');
    let preparation = retain(&tree, claim, 'a');
    let progress = preparation.run().unwrap();
    let (_, outcome) = finish(preparation);
    let reacquired = StorageLease::acquire_launch(&source(&tree, 'a'), &sid(SID)).unwrap();
    reacquired.close().unwrap();
    registry.runtime.close(end()).unwrap();
    assert_eq!(progress, NixProgress::Prepared);
    assert_eq!(outcome, NixDisposition::Prepared);
    assert_eq!(trace(&tree, "create"), 1);
    assert_eq!(trace(&tree, "start"), 1);
    assert_eq!(trace(&tree, "rm"), 1);
    assert!(tree.0.join("removed").exists());
}
#[test]
fn unknown_helper_never_releases_registry_storage_even_after_handle_drop_and_service_stop() {
    crate::test_process::owning_case!(
        unknown_helper_never_releases_registry_storage_even_after_handle_drop_and_service_stop
    );
    for mode in ["unknown-create", "rm-failure"] {
        let tree = Tree::new();
        let registry = registry(&tree, mode);
        let claim = claim(&tree, &registry, 'a');
        let alias = registry.claim(&source(&tree, 'a'), &sid(SID)).unwrap();
        let preparation = retain(&tree, claim, 'a');
        let progress = preparation.run().unwrap();
        let (same, error) = preparation.reclaim().err().unwrap().into_parts();
        let released = alias.release(end()).unwrap_err();
        drop(same);
        let closed = registry.runtime.close(end());
        assert_eq!(progress, NixProgress::Retained);
        assert!(matches!(error, NixStorageError::Nix(_)));
        assert_eq!(released.cause().code(), "WORKER_NIX_STORAGE_RETAINED");
        assert!(closed.is_err());
        assert!(StorageLease::acquire_migration(&source(&tree, 'a'), &sid(SID)).is_err());
        assert!(NixStoreGuard::acquire_migration(&source(&tree, 'a'), &sid(SID)).is_err());
        assert!(matches!(
            registry.entries.lock().unwrap()[0].owner,
            EntryOwner::Nix(_)
        ));
        assert_eq!(trace(&tree, "create"), 1);
    }
}
#[test]
fn pure_retention_failure_returns_original_guard_claim_and_direct_registry_without_engine_io() {
    crate::test_process::owning_case!(
        pure_retention_failure_returns_original_guard_claim_and_direct_registry_without_engine_io
    );
    let tree = Tree::new();
    let registry = registry(&tree, "");
    let claim = claim(&tree, &registry, 'b');
    let paths = claim.paths().clone();
    let raw = source(&tree, 'b');
    let guard = NixStoreGuard::acquire_launch(&raw, &sid(SID)).unwrap();
    let mut changed: serde_json::Value =
        serde_json::from_slice(&worker_config::encode_config(&raw)).unwrap();
    changed["stateRoot"] = json!(tree.0.join("different-state"));
    let changed = worker_config::decode(&serde_json::to_vec(&changed).unwrap()).unwrap();
    let (claim, guard, error) = claim.retain_nix(guard, changed).err().unwrap().into_parts();
    let same = claim.paths() == &paths;
    let busy = NixStoreGuard::acquire_migration(&raw, &sid(SID)).is_err();
    guard.close().unwrap();
    claim.release(end()).unwrap();
    registry.runtime.close(end()).unwrap();
    assert!(same && busy);
    assert!(matches!(error, NixStorageError::Nix(_)));
    assert_eq!(trace(&tree, "image"), 0);
    assert!(registry.entries.lock().unwrap().is_empty());
}

#[test]
fn actual_long_helper_runs_outside_registry_lock_and_restores_owners_after_completion() {
    crate::test_process::owning_case!(
        actual_long_helper_runs_outside_registry_lock_and_restores_owners_after_completion
    );
    let tree = Tree::new();
    let registry = registry(&tree, "running");
    let claim = claim(&tree, &registry, 'a');
    let preparation = retain(&tree, claim, 'a');
    let worker = std::thread::spawn(move || {
        let result = preparation.run();
        (preparation, result)
    });
    let ceiling = Instant::now() + Duration::from_secs(10);
    while !tree.0.join("started").exists() {
        assert!(
            Instant::now() < ceiling,
            "bounded setup observes actual helper start"
        );
        std::thread::sleep(Duration::from_millis(1));
    }
    let registry_was_free = registry.entries.try_lock().is_ok();
    tree.write("complete", b"fixed fixture helper may finish");
    let (preparation, result) = worker.join().unwrap();
    let (_, outcome) = finish(preparation);
    registry.runtime.close(end()).unwrap();
    assert!(registry_was_free);
    assert_eq!(result.unwrap(), NixProgress::Prepared);
    assert_eq!(outcome, NixDisposition::Prepared);
    assert_eq!(trace(&tree, "create"), 1);
    assert_eq!(trace(&tree, "rm"), 1);
}

#[test]
fn actual_app_handoff_preserves_prepared_path_data_across_later_owner_marker_drift() {
    crate::test_process::owning_case!(
        actual_app_handoff_preserves_prepared_path_data_across_later_owner_marker_drift
    );
    let tree = Tree::new();
    tree.write("company.json", br#"{"employees":[]}"#);
    let registry = registry(&tree, "");
    let claim = claim(&tree, &registry, 'a');
    let preparation = retain(&tree, claim, 'a');
    let progress = preparation.run().unwrap();
    let expected = tree.0.join("state").join(SID).join("nix");
    tree.write(
        &format!("state/{SID}/nix-rollback.json"),
        serde_json::to_vec(&json!({"version":1,"sessionId":SID,"legacy":true}))
            .unwrap()
            .as_slice(),
    );
    let returned = preparation.reclaim().unwrap();
    let prepared = returned.prepared_path().unwrap().to_owned();
    let (claim, guard, outcome) = returned.into_parts();
    let later = guard.selected_path().unwrap();
    guard.close().unwrap();
    claim.release(end()).unwrap();
    registry.runtime.close(end()).unwrap();
    assert_eq!(progress, NixProgress::Prepared);
    assert_eq!(outcome.unwrap(), NixDisposition::Prepared);
    assert_eq!(prepared, expected);
    assert_ne!(prepared, later);
    assert_eq!(trace(&tree, "create"), 1);
}

#[test]
fn retained_nix_refuses_observed_plan_before_late_company_metadata() {
    crate::test_process::owning_case!(
        retained_nix_refuses_observed_plan_before_late_company_metadata
    );
    let tree = Tree::new();
    let registry = registry(&tree, "");
    let source = source(&tree, 'b');
    fs::create_dir(tree.0.join("work")).unwrap();
    let mut raw: serde_json::Value =
        serde_json::from_slice(&worker_config::encode_config(&source)).unwrap();
    raw["mounts"] =
        json!([{"source":tree.0.join("work"),"destination":"/workspace","readOnly":false}]);
    for (key, value) in [
        ("version", json!(1)),
        ("socket", json!("/run/nix-observed-plan.sock")),
        ("companyRoot", json!(tree.0.join("company"))),
        ("apiSocketRoot", json!(tree.0.join("api"))),
        ("cgroupParent", json!("reverie-workers.slice")),
        ("maintenanceSessions", json!([])),
    ] {
        raw[key] = value;
    }
    let captured = crate::worker_validation::validate_captured(
        worker_config::decode(&serde_json::to_vec(&raw).unwrap()).unwrap(),
    )
    .unwrap();
    let claim = claim(&tree, &registry, 'b');
    let alias = registry.claim(&source, &sid(SID)).unwrap();
    let preparation = retain(&tree, claim, 'b');
    fs::remove_file(tree.0.join("company.json")).unwrap();
    let error = alias.prepare_create_plan(&captured).err().unwrap();
    tree.company(SID, EID);
    let progress = preparation.run().unwrap();
    finish(preparation);
    alias.release(end()).unwrap();
    registry.runtime.close(end()).unwrap();
    assert!(
        matches!(error,super::super::observed::OwnedCreatePreparationError::Storage(ref cause) if cause.code()=="WORKER_NIX_STORAGE_RETAINED")
    );
    assert_eq!(progress, NixProgress::NoHelper);
}
