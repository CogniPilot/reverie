use super::*;
use reverie_contracts::reservation_control::{PoolTransitionIntent, PoolTransitionSelection};
use reverie_core::operations::{JournalDigest, JournalId, OperationScope};
use std::sync::Arc;

fn intent(tree: &Tree, binding: &ControlBinding) -> Arc<PoolTransitionIntent> {
    let selected = PoolTransitionSelection::new(
        JournalId::parse("aaaaaaaa-0000-4000-8000-000000000001").unwrap(),
        JournalId::parse("aaaaaaaa-0000-4000-8000-000000000002").unwrap(),
        JournalDigest::parse(&"a".repeat(64)).unwrap(),
        JournalDigest::parse(&"b".repeat(64)).unwrap(),
        JournalDigest::parse(&"c".repeat(64)).unwrap(),
        JournalDigest::parse(&worker_config::config_digest(tree.config.configuration()).to_hex())
            .unwrap(),
    );
    let scope = OperationScope {
        company_id: JournalId::parse("11111111-2222-4333-8444-555555555555").unwrap(),
        owner_scope_digest: JournalDigest::parse(&"d".repeat(64)).unwrap(),
    };
    Arc::new(
        PoolTransitionIntent::capture(&selected, &scope, binding, tree.config.configuration())
            .unwrap(),
    )
}
#[test]
fn actual_pending_writer_is_exclusive_and_drop_keeps_same_durable_leaf() {
    let tree = Tree::new();
    let binding = tree.binding();
    let intent = intent(&tree, &binding);
    let mut lock = AdmissionLock::acquire(&tree.config).unwrap();
    guard_layout(&tree.config, &binding, &lock).unwrap();
    let pending =
        PoolTransitionPending::establish(&tree.config, &binding, &lock, intent.clone()).unwrap();
    pending.assert_current(&tree.config).unwrap();
    let path = tree.root.join("state/resource-reservation-control.pending");
    let before = native::PrivateFileStamp::of(&fs::symlink_metadata(&path).unwrap());
    assert!(
        PoolTransitionPending::establish(&tree.config, &binding, &lock, intent.clone()).is_err()
    );
    drop(pending);
    lock.close().unwrap();
    assert_eq!(
        native::PrivateFileStamp::of(&fs::symlink_metadata(&path).unwrap()),
        before
    );
    assert_eq!(fs::read(path).unwrap(), intent.bytes());
}
#[test]
fn actual_postpublication_consumed_close_fault_keeps_pending_and_original_cause() {
    let tree = Tree::new();
    let binding = tree.binding();
    let intent = intent(&tree, &binding);
    let mut lock = AdmissionLock::acquire(&tree.config).unwrap();
    let owner =
        PoolTransitionPending::establish(&tree.config, &binding, &lock, intent.clone()).unwrap();
    let path = tree.root.join("state/resource-reservation-control.pending");
    let expected = path.clone();
    let reads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed_reads = reads.clone();
    native::test_faults::set(
        Some(Box::new(move |observed| {
            assert_eq!(observed, expected);
            observed_reads.fetch_add(1, Ordering::SeqCst);
            native::test_faults::set(None, true);
            Ok(())
        })),
        false,
    );
    let result = owner.assert_current(&tree.config);
    let closed = lock.close();
    let error = result.err().unwrap();
    assert!(error.has_unconfirmed_close());
    let ControlHostError::PoolTransitionClose(error) = error else {
        panic!("original native cause must remain typed");
    };
    assert!(error.has_unconfirmed_close());
    closed.unwrap();
    let observed_reads = reads.clone();
    native::test_faults::set(
        Some(Box::new(move |_| {
            observed_reads.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })),
        false,
    );
    let repeated = owner.assert_current(&tree.config).unwrap_err();
    native::test_faults::set(None, false);
    let ControlHostError::PoolTransitionClose(repeated) = repeated else {
        panic!("original close opacity must remain typed");
    };
    assert!(Arc::ptr_eq(&error, &repeated));
    assert_eq!(
        reads.load(Ordering::SeqCst),
        1,
        "latched owner performs no new native read"
    );
    let before = native::PrivateFileStamp::of(&fs::symlink_metadata(&path).unwrap());
    assert_eq!(fs::read(&path).unwrap(), intent.bytes());
    assert_eq!(
        native::PrivateFileStamp::of(&fs::symlink_metadata(&path).unwrap()),
        before
    );
    assert_eq!(fs::read(path).unwrap(), intent.bytes());
}
