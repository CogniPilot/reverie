//! Actual registry dispatch, retaining its original held/legacy resource sum.
use super::*;

#[test]
fn actual_runtime_directory_precedes_home_alias_check_without_overwriting_occupied_entries() {
    crate::test_process::owning_case!(
        actual_runtime_directory_precedes_home_alias_check_without_overwriting_occupied_entries
    );
    for occupied in [false, true] {
        let tree = Tree::new();
        let registry = tree.registry();
        let source = tree.source();
        let mut claim = registry.claim(&source, &sid(SID)).unwrap();
        claim.prepare_cold_launch_storage().unwrap();
        let paths = claim.paths().clone();
        let original = paths.home().with_file_name("home-preserved");
        fs::write(paths.home().join("AGENTS.md"), "owner authored text").unwrap();
        fs::rename(paths.home(), &original).unwrap();
        std::os::unix::fs::symlink(&original, paths.home()).unwrap();
        let runtime = tree.0.join("state").join(SID);
        if occupied {
            fs::write(&runtime, "owner occupied runtime leaf").unwrap();
        }
        let error = claim.prepare_runtime_directory().err().unwrap();
        if occupied {
            assert!(
                matches!(error.owner_error(),Some(StorageOwnerError::Storage(reverie_host::worker_storage::StorageError::Io(cause))) if cause.kind()==std::io::ErrorKind::NotADirectory)
            );
            assert_eq!(
                fs::read_to_string(&runtime).unwrap(),
                "owner occupied runtime leaf"
            );
        } else {
            assert!(
                runtime.is_dir(),
                "private runtime directory was created BEFORE canonical home refusal"
            );
            assert!(
                matches!(error.owner_error(),Some(StorageOwnerError::Storage(cause)) if cause.may_have_effects())
            );
        }
        assert_eq!(fs::read_link(paths.home()).unwrap(), original);
        assert_eq!(
            fs::read_to_string(original.join("AGENTS.md")).unwrap(),
            "owner authored text"
        );
        claim.release(end()).unwrap();
        registry.runtime.close(end()).unwrap();
    }
}

#[test]
fn actual_cold_prerequisite_uses_same_registered_and_legacy_owner_and_retains_pending_refusal() {
    crate::test_process::owning_case!(
        actual_cold_prerequisite_uses_same_registered_and_legacy_owner_and_retains_pending_refusal
    );
    for employee in [false, true] {
        let tree = Tree::new();
        let registry = tree.registry();
        let mut raw: serde_json::Value =
            serde_json::from_slice(&worker_config::encode_config(&tree.source())).unwrap();
        raw["coldTemporaryCleanup"] = json!({"version":1,"enabled":true,"hostLeaseDirectories":[]});
        let source = worker_config::decode(&serde_json::to_vec(&raw).unwrap()).unwrap();
        let session = sid(if employee { SID } else { NEXT_SID });
        let mut claim = registry.claim(&source, &session).unwrap();
        let paths = claim.paths().clone();
        assert!(!paths.home().exists());
        claim.prepare_cold_launch_storage().unwrap();
        assert_eq!(claim.paths(), &paths);
        assert!(paths.home().join(".local/state/reverie/leases").is_dir());
        assert_eq!(
            registry.entries.lock().unwrap().len(),
            usize::from(employee)
        );
        assert_eq!(
            tree.calls(),
            usize::from(employee),
            "only the real held acquisition's writer census dispatches an engine query"
        );
        let pending = paths.root().join("cold-tmp-cleanup.pending.json");
        fs::write(&pending, "owner reconciliation evidence").unwrap();
        assert_eq!(
            claim.prepare_cold_launch_storage().err().unwrap().code(),
            "WORKER_COLD_RECONCILIATION_REQUIRED"
        );
        assert_eq!(
            fs::read_to_string(&pending).unwrap(),
            "owner reconciliation evidence"
        );
        if employee {
            assert!(StorageLease::acquire_launch(&source, &session).is_err());
        } else {
            assert!(!tree.0.join("state/storage-locks").exists());
        }
        claim.release(end()).unwrap();
        registry.runtime.close(end()).unwrap();
    }
}
