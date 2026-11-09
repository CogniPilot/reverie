//! Store-only native Directory/lease custody. These trusted installation test
//! guards model metadata phase boundaries, not an authenticated Q producer.
use super::super::{RamClaimJournal, RamClaimScope};
use super::*;
struct RamGuard {
    domain: Arc<()>,
    phase: Arc<()>,
    live: AtomicBool,
    calls: AtomicUsize,
}
impl RamGuard {
    fn new(domain: Arc<()>) -> Arc<Self> {
        Arc::new(Self {
            domain,
            phase: Arc::new(()),
            live: AtomicBool::new(true),
            calls: AtomicUsize::new(0),
        })
    }
    fn successor(&self) -> Arc<Self> {
        Self::new(self.domain.clone())
    }
}
impl ScopeGuard for RamGuard {
    fn assert_scope(&self, selected: &OperationScope) -> Result<()> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        need(
            *selected == scope() && self.live.load(Ordering::SeqCst),
            "TEST_PHASE_REVOKED",
        )
    }
}
impl RamClaimScope for RamGuard {
    fn assert_ram_claim_scope(&self, selected: &OperationScope) -> Result<()> {
        self.assert_scope(selected)
    }
    fn assert_ram_claim_successor(&self, prior: &Self, selected: &OperationScope) -> Result<()> {
        need(
            *selected == scope()
                && Arc::ptr_eq(&self.domain, &prior.domain)
                && !Arc::ptr_eq(&self.phase, &prior.phase),
            "TEST_RAM_PHASE_CHANGED",
        )
    }
}
fn claimed(tree: &Tree, guard: &Arc<RamGuard>) -> (OperationStore, OperationView, OperationHandle) {
    tree.initialized().close().unwrap();
    let store =
        OperationStore::open(&tree.root, guard.clone(), Some(tree.observer.clone())).unwrap();
    let (view, handle) = tree.claim(&store);
    (store, view, handle)
}
#[test]
fn same_directory_and_actual_handle_cross_phases_without_reopening_old_guard() {
    let tree = Tree::new();
    let a = RamGuard::new(Arc::new(()));
    let (store, view, handle) = claimed(&tree, &a);
    let inode = fs::metadata(&tree.root).unwrap().ino();
    let phase = RamClaimJournal::retain(store, handle, a.clone(), scope(), view).unwrap();
    let suspended = phase.suspend().unwrap();
    a.live.store(false, Ordering::SeqCst);
    // A separate real journal owner may add an unrelated operation. The
    // selected view/lease must remain exact without freezing the whole file.
    let other = tree.open();
    other
        .claim(
            &scope(),
            &id(3),
            &request(id(5), 32),
            &ClaimSelection::default(),
        )
        .unwrap();
    other.close().unwrap();
    let b = a.successor();
    let mut phase = suspended.resume(b.clone()).unwrap();
    assert!(a.assert_scope(&scope()).is_err());
    assert_eq!(tree.descriptor_count(), 1);
    assert_eq!(fs::metadata(&tree.root).unwrap().ino(), inode);
    assert_eq!(
        phase
            .begin_effect(Effect::Prepare, version(1))
            .unwrap()
            .state(),
        OperationState::Preparing
    );
    assert_eq!(
        phase
            .record_ack(Effect::Prepare, digest(9), version(2))
            .unwrap()
            .state(),
        OperationState::Prepared
    );
    let suspended = phase.suspend().unwrap();
    b.live.store(false, Ordering::SeqCst);
    let mut phase = suspended.resume(b.successor()).unwrap();
    assert!(a.assert_scope(&scope()).is_err() && b.assert_scope(&scope()).is_err());
    let view = phase.begin_effect(Effect::Start, version(3)).unwrap();
    assert_eq!(view.state(), OperationState::Starting);
    assert!(view.reservation_retained() && !view.verified());
    phase.close_component().unwrap();
    assert_eq!(tree.descriptor_count(), 0);
}
#[test]
fn foreign_or_same_phase_successor_refuses_before_guard_io_and_keeps_claim_bytes() {
    for same_phase in [false, true] {
        let tree = Tree::new();
        let a = RamGuard::new(Arc::new(()));
        let (store, view, handle) = claimed(&tree, &a);
        let suspended = RamClaimJournal::retain(store, handle, a.clone(), scope(), view)
            .unwrap()
            .suspend()
            .unwrap();
        let before = tree.raw();
        let next = if same_phase {
            a.clone()
        } else {
            RamGuard::new(Arc::new(()))
        };
        let calls = next.calls.load(Ordering::SeqCst);
        let mut failure = suspended.resume(next.clone()).err().unwrap();
        assert_eq!(failure.cause().code(), "TEST_RAM_PHASE_CHANGED");
        assert_eq!(next.calls.load(Ordering::SeqCst), calls);
        assert_eq!(tree.raw(), before);
        assert_eq!(tree.descriptor_count(), 1);
        failure.close_component().unwrap();
        assert_eq!(tree.descriptor_count(), 0);
    }
}
impl RamClaimScope for Guard {}
#[test]
fn ordinary_guard_cannot_mint_ram_phase_and_actual_claim_stays_retained() {
    let tree = Tree::new();
    let store = tree.initialized();
    let (view, handle) = tree.claim(&store);
    let bytes = tree.raw();
    let mut failure = RamClaimJournal::retain(store, handle, tree.guard.clone(), scope(), view)
        .err()
        .unwrap();
    assert_eq!(failure.cause().code(), "RAM_JOURNAL_SCOPE_REQUIRED");
    assert_eq!(tree.raw(), bytes);
    failure.close_component().unwrap();
    let cold = tree.open();
    let view = cold.lookup(&scope(), &id(2)).unwrap().unwrap();
    assert_eq!(view.state(), OperationState::RecoveryRequired);
    assert!(view.reservation_retained() && !view.retry_allowed());
    cold.close().unwrap();
    assert_eq!(tree.descriptor_count(), 0);
}
#[test]
fn foreign_actual_handle_is_refused_before_guard_io_and_original_store_is_owned() {
    let tree = Tree::new();
    let guard = RamGuard::new(Arc::new(()));
    let (original, view, handle) = claimed(&tree, &guard);
    let unclaimed = OperationStore::open(&tree.root, guard.clone(), None).unwrap();
    let calls = guard.calls.load(Ordering::SeqCst);
    let bytes = tree.raw();
    let mut failure = RamClaimJournal::retain(unclaimed, handle, guard.clone(), scope(), view)
        .err()
        .unwrap();
    assert_eq!(failure.cause().code(), "MISSING_ACTIVE_CLAIM");
    assert_eq!(guard.calls.load(Ordering::SeqCst), calls);
    assert_eq!(tree.raw(), bytes);
    assert_eq!(tree.descriptor_count(), 2);
    failure.close_component().unwrap();
    original.close().unwrap();
    assert_eq!(tree.descriptor_count(), 0);
}
#[test]
fn actual_lock_close_failure_during_resume_keeps_directory_handle_and_first_cause() {
    let tree = Tree::new();
    let a = RamGuard::new(Arc::new(()));
    let (store, view, handle) = claimed(&tree, &a);
    let suspended = RamClaimJournal::retain(store, handle, a.clone(), scope(), view)
        .unwrap()
        .suspend()
        .unwrap();
    a.live.store(false, Ordering::SeqCst);
    let bytes = tree.raw();
    faults::STATE.with(|state| state.borrow_mut().close = Some(CloseRole::Lock));
    let mut failure = suspended.resume(a.successor()).err().unwrap();
    let original = failure.cause().clone();
    assert!(matches!(&*original, JournalError::Filesystem(_)));
    assert_eq!(
        tree.descriptor_count(),
        1,
        "actual lock consumed; original Directory still held"
    );
    assert_eq!(tree.raw(), bytes);
    failure.close_component().unwrap();
    assert!(Arc::ptr_eq(&original, failure.cause()));
    assert_eq!(tree.descriptor_count(), 0);
}
#[test]
fn directory_consuming_close_is_sticky_and_a_second_fault_is_not_replayed() {
    let tree = Tree::new();
    let a = RamGuard::new(Arc::new(()));
    let (store, view, handle) = claimed(&tree, &a);
    let mut phase = RamClaimJournal::retain(store, handle, a, scope(), view).unwrap();
    faults::STATE.with(|state| state.borrow_mut().close = Some(CloseRole::Store));
    let first = phase.close_component().unwrap_err();
    assert_eq!(tree.descriptor_count(), 0);
    faults::STATE.with(|state| state.borrow_mut().close = Some(CloseRole::Store));
    let second = phase.close_component().unwrap_err();
    assert!(Arc::ptr_eq(&first, &second));
    let sentinel = tree.open();
    assert!(
        sentinel.close().is_err(),
        "fresh actual Directory consumes untouched second fault"
    );
    assert_eq!(tree.descriptor_count(), 0);
}
#[test]
fn aborted_custody_performs_no_guard_read_or_lock_and_only_closes_its_component() {
    let tree = Tree::new();
    let guard = RamGuard::new(Arc::new(()));
    let (store, view, handle) = claimed(&tree, &guard);
    let phase = RamClaimJournal::retain(store, handle, guard.clone(), scope(), view).unwrap();
    let bytes = tree.raw();
    let calls = guard.calls.load(Ordering::SeqCst);
    guard.live.store(false, Ordering::SeqCst);
    faults::STATE.with(|state| state.borrow_mut().close = Some(CloseRole::Lock));
    let mut aborted = phase.abort();
    assert_eq!(guard.calls.load(Ordering::SeqCst), calls);
    assert_eq!(tree.raw(), bytes);
    assert_eq!(tree.descriptor_count(), 1);
    aborted.close_component().unwrap();
    assert_eq!(tree.descriptor_count(), 0);
    let sentinel = tree.open();
    assert!(
        sentinel.snapshot(&scope()).is_err(),
        "fresh actual lock still consumes untouched fault"
    );
    sentinel.close().unwrap();
    assert_eq!(tree.descriptor_count(), 0);
}
