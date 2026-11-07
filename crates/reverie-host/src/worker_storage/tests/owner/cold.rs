use super::*;

fn configured(tree: &Tree, enabled: bool) -> EffectiveWorkerConfig {
    let mut raw: Value =
        serde_json::from_slice(&worker_config::encode_config(&selected(tree))).unwrap();
    if enabled {
        raw["coldTemporaryCleanup"] = json!({"version":1,"enabled":true,"hostLeaseDirectories":[]});
    }
    config(raw)
}
fn owner(runtime: &WorkerRuntime, source: &EffectiveWorkerConfig, leased: bool) -> LaunchStorage {
    let selected = runtime
        .resolve_storage(source, &session(if leased { A } else { B }))
        .unwrap();
    if leased {
        selected
            .acquire()
            .unwrap_or_else(|_| panic!("real employee lease"))
    } else {
        selected.into_legacy().unwrap()
    }
}
fn leases(owner: &LaunchStorage) -> PathBuf {
    owner.paths().home().join(".local/state/reverie/leases")
}

#[test]
fn actual_fresh_legacy_and_leased_homes_initialize_only_enabled_cold_leases() {
    for leased in [false, true] {
        let tree = Tree::new();
        let runtime = runtime(&tree);
        let mut owner = owner(&runtime, &configured(&tree, true), leased);
        assert!(!owner.paths().home().exists());
        owner.prepare_cold_launch_storage().unwrap();
        let info = stdfs::symlink_metadata(leases(&owner)).unwrap();
        assert!(info.is_dir());
        assert_eq!(info.uid(), native::uid());
        assert_eq!(info.mode() & 0o777, 0o700);
        assert_eq!(
            owner.ownership_kind(),
            if leased {
                StorageOwnershipKind::HeldLease
            } else {
                StorageOwnershipKind::UnleasedLegacy
            }
        );
        owner.check_resource_current().unwrap();
        owner.close(end()).unwrap();
        runtime.close(end()).unwrap();
    }
}

#[test]
fn existing_home_is_not_repaired_after_its_cold_lease_directory_disappears() {
    let tree = Tree::new();
    let runtime = runtime(&tree);
    let mut owner = owner(&runtime, &configured(&tree, true), true);
    owner.prepare_cold_launch_storage().unwrap();
    stdfs::remove_dir(leases(&owner)).unwrap();
    owner.prepare_cold_launch_storage().unwrap();
    assert!(
        !leases(&owner).exists(),
        "existing homes require explicit reconciliation"
    );
    owner.close(end()).unwrap();
    runtime.close(end()).unwrap();
}

#[test]
fn absent_cold_policy_prepares_storage_without_creating_cold_lease_inventory() {
    let tree = Tree::new();
    let runtime = runtime(&tree);
    let mut owner = owner(&runtime, &configured(&tree, false), false);
    owner.prepare_cold_launch_storage().unwrap();
    assert!(owner.paths().home().is_dir());
    assert!(!leases(&owner).exists());
    assert!(!tree.state().join("storage-locks").exists());
    owner.close(end()).unwrap();
    runtime.close(end()).unwrap();
}

#[test]
fn overlapping_cold_policy_refuses_before_preparing_a_new_home() {
    let tree = Tree::new();
    let runtime = runtime(&tree);
    let mut raw: Value =
        serde_json::from_slice(&worker_config::encode_config(&configured(&tree, true))).unwrap();
    raw["coldTemporaryCleanup"]["hostLeaseDirectories"] = json!([tree.state()]);
    let mut owner = owner(&runtime, &config(raw), true);
    assert!(!owner.paths().home().exists());
    assert_eq!(
        owner.prepare_cold_launch_storage().unwrap_err().code(),
        "WORKER_COLD_POLICY"
    );
    assert!(!owner.paths().home().exists());
    owner.check_resource_current().unwrap();
    owner.close(end()).unwrap();
    runtime.close(end()).unwrap();
}

#[test]
fn pending_regular_and_broken_symlink_fence_both_owners_before_home_creation() {
    for leased in [false, true] {
        for symlink in [false, true] {
            let tree = Tree::new();
            let runtime = runtime(&tree);
            let mut owner = owner(&runtime, &configured(&tree, true), leased);
            tree.mkdir(owner.paths().root());
            let marker = owner.paths().root().join("cold-tmp-cleanup.pending.json");
            if symlink {
                std::os::unix::fs::symlink("missing-owned-pending-target", &marker).unwrap();
            } else {
                tree.write(&marker, b"retained unknown cleanup");
            }
            let identity = stdfs::symlink_metadata(&marker).unwrap();
            assert!(!owner.paths().home().exists());
            assert_eq!(
                owner.prepare_cold_launch_storage().unwrap_err().code(),
                "WORKER_COLD_RECONCILIATION_REQUIRED"
            );
            assert!(!owner.paths().home().exists());
            let after = stdfs::symlink_metadata(&marker).unwrap();
            assert_eq!(
                (after.dev(), after.ino(), after.mode()),
                (identity.dev(), identity.ino(), identity.mode())
            );
            owner.check_resource_current().unwrap();
            owner.close(end()).unwrap();
            runtime.close(end()).unwrap();
        }
    }
}
