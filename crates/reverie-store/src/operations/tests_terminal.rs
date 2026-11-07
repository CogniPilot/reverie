use super::*;
#[derive(Default)]
struct TerminalGuard {
    ordinary: AtomicUsize,
    terminal: AtomicUsize,
    denied: AtomicBool,
}
impl ScopeGuard for TerminalGuard {
    fn assert_scope(&self, _: &OperationScope) -> Result<()> {
        self.ordinary.fetch_add(1, Ordering::SeqCst);
        Err(JournalError::refusal("UNEXPECTED_NATIVE_GUARD"))
    }
    fn assert_terminal_admission(&self, selected: &OperationScope) -> Result<()> {
        self.terminal.fetch_add(1, Ordering::SeqCst);
        need(
            selected == &scope() && !self.denied.load(Ordering::SeqCst),
            "RESERVATION_ADMISSION_LOCK_REQUIRED",
        )
    }
}
fn initialized(tree: &Tree) -> OperationDocument {
    let store = tree.initialized();
    let document = store.snapshot(&scope()).unwrap();
    store.close().unwrap();
    document
}
#[test]
fn terminal_reader_closes_every_descriptor_before_returning_original_stamp() {
    let tree = Tree::new();
    let document = initialized(&tree);
    let guard = Arc::new(TerminalGuard::default());
    let store = OperationStore::open(&tree.root, guard.clone(), None).unwrap();
    let stamp = store
        .into_exact_terminal_stamp(&scope(), &document)
        .unwrap();
    assert_eq!(tree.descriptor_count(), 0);
    assert_eq!(guard.ordinary.load(Ordering::SeqCst), 0);
    assert_eq!(guard.terminal.load(Ordering::SeqCst), 1);
    // Model the caller's LAST native observation after all reader closes. A
    // same-byte replacement there must be caught by the later named stamp.
    let previous = tree.root.join("before-native-guard.json");
    fs::rename(tree.root.join("operations.json"), &previous).unwrap();
    fs::write(
        tree.root.join("operations.json"),
        fs::read(previous).unwrap(),
    )
    .unwrap();
    fs::set_permissions(
        tree.root.join("operations.json"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    assert_eq!(
        stamp.assert_named_current().err().unwrap().code(),
        "RESERVATION_CLAIM_CHANGED"
    );
}
#[test]
fn terminal_read_scope_and_all_finalizer_failures_prevent_a_success_stamp() {
    for role in [CloseRole::Data, CloseRole::Lock, CloseRole::Store] {
        let tree = Tree::new();
        let document = initialized(&tree);
        let store = tree.open();
        faults::STATE.with(|value| value.borrow_mut().close = Some(role));
        assert!(
            store
                .into_exact_terminal_stamp(&scope(), &document)
                .is_err()
        );
        assert_eq!(tree.descriptor_count(), 0);
    }
    let tree = Tree::new();
    let document = initialized(&tree);
    let guard = Arc::new(TerminalGuard::default());
    guard.denied.store(true, Ordering::SeqCst);
    let store = OperationStore::open(&tree.root, guard, None).unwrap();
    assert_eq!(
        store
            .into_exact_terminal_stamp(&scope(), &document)
            .err()
            .unwrap()
            .code(),
        "RESERVATION_ADMISSION_LOCK_REQUIRED"
    );
    assert_eq!(tree.descriptor_count(), 0);
}
#[test]
fn terminal_document_mismatch_and_store_close_error_are_both_retained() {
    let tree = Tree::new();
    let store = tree.initialized();
    tree.claim(&store);
    store.close().unwrap();
    let reader = tree.open();
    faults::STATE.with(|value| value.borrow_mut().close = Some(CloseRole::Store));
    let error = reader
        .into_exact_terminal_stamp(&scope(), &OperationDocument::empty())
        .err()
        .unwrap();
    match error {
        JournalError::Finalization { primary, secondary } => {
            assert_eq!(primary.code(), "RESERVATION_CLAIM_CHANGED");
            assert_eq!(secondary.code(), "LEDGER_UNAVAILABLE");
        }
        other => panic!("expected both terminal failures, got {other:?}"),
    }
    assert_eq!(tree.descriptor_count(), 0);
}
#[test]
fn terminal_named_stamp_accepts_unchanged_data_and_refuses_in_place_mutation() {
    let tree = Tree::new();
    let document = initialized(&tree);
    let stamp = tree
        .open()
        .into_exact_terminal_stamp(&scope(), &document)
        .unwrap();
    stamp.assert_named_current().unwrap();
    let mut raw = tree.raw();
    raw.push(b' ');
    fs::write(tree.root.join("operations.json"), raw).unwrap();
    assert_eq!(
        stamp.assert_named_current().err().unwrap().code(),
        "RESERVATION_CLAIM_CHANGED"
    );
}
fn prepared(tree: &Tree) -> (OperationStore, OperationHandle, OperationView) {
    let store = tree.initialized();
    let (_, handle) = tree.claim(&store);
    store
        .begin_effect(&scope(), &handle, Effect::Prepare, version(1))
        .unwrap();
    let view = store
        .record_ack(&scope(), &handle, Effect::Prepare, digest(9), version(2))
        .unwrap();
    (store, handle, view)
}
#[test]
fn native_start_snapshot_is_exact_prepared_or_starting_data_after_all_reader_closes() {
    for starting in [false, true] {
        let tree = Tree::new();
        let (store, handle, prepared) = prepared(&tree);
        let view = if starting {
            store
                .begin_effect(&scope(), &handle, Effect::Start, version(3))
                .unwrap()
        } else {
            prepared
        };
        store.close().unwrap();
        let guard = Arc::new(TerminalGuard::default());
        let reader = OperationStore::open(&tree.root, guard.clone(), None).unwrap();
        let (document, stamp) = reader.into_native_start_snapshot(&scope(), &view).unwrap();
        assert_eq!(tree.descriptor_count(), 0);
        assert_eq!(
            &document.operations()[&view.record().data().id],
            view.record()
        );
        assert_eq!(guard.ordinary.load(Ordering::SeqCst), 0);
        stamp.assert_native_start_named_current().unwrap();
        let saved = tree.root.join("preserved-native-document");
        fs::rename(tree.root.join("operations.json"), &saved).unwrap();
        fs::write(tree.root.join("operations.json"), fs::read(saved).unwrap()).unwrap();
        assert_eq!(
            stamp
                .assert_native_start_named_current()
                .unwrap_err()
                .code(),
            "RESOURCE_NATIVE_CLAIM_CHANGED"
        );
    }
}
#[test]
fn stale_native_start_view_and_checked_store_close_both_survive_finalization() {
    let tree = Tree::new();
    let (store, handle, prepared) = prepared(&tree);
    store
        .begin_effect(&scope(), &handle, Effect::Start, version(3))
        .unwrap();
    store.close().unwrap();
    faults::STATE.with(|value| value.borrow_mut().close = Some(CloseRole::Store));
    let error = tree
        .open()
        .into_native_start_snapshot(&scope(), &prepared)
        .err()
        .unwrap();
    match error {
        JournalError::Finalization { primary, secondary } => {
            assert_eq!(primary.code(), "RESOURCE_NATIVE_CLAIM_CHANGED");
            assert_eq!(secondary.code(), "LEDGER_UNAVAILABLE");
        }
        other => panic!("expected both native snapshot errors, got {other:?}"),
    }
    assert_eq!(tree.descriptor_count(), 0);
}
