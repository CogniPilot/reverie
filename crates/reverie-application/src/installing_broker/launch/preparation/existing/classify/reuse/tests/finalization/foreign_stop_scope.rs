//! Matching target spelling and a valid foreign broker admission cannot act
//! on another original registry. The provider is an owned Rust fixture child.
use super::broker as make_broker;
use super::*;
#[test]
fn matching_foreign_broker_admission_cannot_stop_the_original_native_registry() {
    crate::test_process::owning_case!(
        matching_foreign_broker_admission_cannot_stop_the_original_native_registry
    );
    let tree = Tree::new();
    let broker = make_broker(&tree);
    employee(&tree);
    let other_tree = Tree::new();
    let other = make_broker(&other_tree);
    let mut provider = Provider::new(&tree);
    let reuse = reusable(&tree, &broker);
    let exit = receipt(&reuse);
    let source = reuse.inspected.observed.current.configuration().clone();
    let owner = reuse.prepare_viewer().unwrap().close_allocation().unwrap();
    enable(&tree, provider.child.id());
    fs::create_dir_all(exit.parent().unwrap()).unwrap();
    fs::write(exit, b"0").unwrap();
    let target = owner.retained.native.target().unwrap();
    let observed_completed = owner.retained.native.completed().unwrap();
    let admission = other.admit_ordinary_stop(&target).unwrap();
    let before = fs::read(tree.root.join("calls.txt")).unwrap();
    let refused = owner
        .retained
        .native
        .stop_under_admission(&other, admission);
    let after = fs::read(tree.root.join("calls.txt")).unwrap();
    let alive_before_cleanup = provider.child.try_wait().unwrap().is_none();
    let closed = match owner.finalize_for_worker() {
        Ok(closed) => Ok(closed),
        Err(owner) => owner.reconcile_handler(),
    };
    let completed = closed
        .as_ref()
        .is_ok_and(|closed| closed.completed() && !closed.storage_retained());
    let lease = reverie_host::worker_storage::StorageLease::acquire_migration(
        &source,
        &ProfileSessionId::parse(SID).unwrap(),
    );
    let released = lease.is_ok();
    if let Ok(lease) = lease {
        lease.close().unwrap();
    }
    drop(provider);
    let source_closed = broker.close_command_telemetry(end());
    let foreign_closed = other.close_command_telemetry(end());
    assert!(
        matches!(
            &refused,
            Err(ExistingStorageError::Refused("WORKER_STOP_STORAGE_ORIGIN"))
        ),
        "foreign registry body={refused:?}; original-finalization={closed:?}; source-telemetry={source_closed:?}; foreign-telemetry={foreign_closed:?}"
    );
    assert_eq!(before, after);
    assert!(observed_completed && alive_before_cleanup && completed && released);
    assert!(
        source_closed.is_ok() && foreign_closed.is_ok(),
        "source={source_closed:?}; foreign={foreign_closed:?}"
    );
}
