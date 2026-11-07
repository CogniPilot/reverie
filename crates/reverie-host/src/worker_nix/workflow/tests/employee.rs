use super::*;
use crate::worker_storage::{StorageLease, StorageOwnershipKind};

fn retain_employee(tree: &Tree, runtime: &WorkerRuntime) -> NixWorkflow {
    let employee = "11111111-2222-4333-8444-555555555555";
    fs::write(
        tree.root.join("company.json"),
        serde_json::to_vec(&json!({
            "employees":[{"id":employee,"sessionId":SID,"owner":null,"desiredRunning":true}]
        }))
        .unwrap(),
    )
    .unwrap();
    fs::write(
        tree.root.join("plan-moves.json"),
        serde_json::to_vec(&json!([
            {"employeeId":employee,"owner":null,"oldSession":SID,
             "newSession":"00000000-0000-0000-0000-000000000000","phase":"completed"}
        ]))
        .unwrap(),
    )
    .unwrap();
    fs::set_permissions(
        tree.root.join("plan-moves.json"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    let source = tree.source('a');
    let session = ProfileSessionId::parse(SID).unwrap();
    let mut storage = runtime
        .resolve_storage(&source, &session)
        .unwrap()
        .acquire()
        .unwrap();
    assert_eq!(storage.ownership_kind(), StorageOwnershipKind::HeldLease);
    storage.prepare_storage().unwrap();
    storage.record_storage_binding().unwrap();
    let guard = NixStoreGuard::acquire_launch(&source, &session).unwrap();
    runtime
        .retain_nix_store(guard, storage, source)
        .unwrap_or_else(|_| panic!("actual employee ownership transfer failed"))
}

#[test]
fn unknown_helper_slot_retains_actual_employee_flock_across_transports_and_handle_drop() {
    if crate::test_process::isolate_case(
        "worker_nix::workflow::tests::employee::unknown_helper_slot_retains_actual_employee_flock_across_transports_and_handle_drop",
    ) {
        return;
    }
    for mode in ["unknown-create", "rm-failure"] {
        let tree = Tree::new();
        let runtime = tree.runtime(mode, Hooks::default());
        let workflow = retain_employee(&tree, &runtime);
        assert_eq!(
            runtime.run_nix_store(&workflow).unwrap(),
            NixProgress::Retained
        );
        assert!(runtime.reclaim_nix_store(workflow.clone()).is_err());
        drop(workflow);
        assert!(runtime.close(end()).is_err());
        for sid in [SID, "00000000-0000-0000-0000-000000000000"] {
            let sid = ProfileSessionId::parse(sid).unwrap();
            assert!(StorageLease::acquire_launch(&tree.source('a'), &sid).is_err());
            assert!(StorageLease::acquire_migration(&tree.source('a'), &sid).is_err());
        }
        assert!(
            NixStoreGuard::acquire_migration(
                &tree.source('a'),
                &ProfileSessionId::parse(SID).unwrap()
            )
            .is_err()
        );
        assert_eq!(count(&tree, "create"), 1);
        assert_eq!(count(&tree, "rm"), usize::from(mode == "rm-failure"));
    }
}
