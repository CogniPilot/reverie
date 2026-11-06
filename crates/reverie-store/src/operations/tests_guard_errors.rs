use super::*;
struct ReadFailure {
    count: AtomicUsize,
    path: PathBuf,
}
impl ScopeGuard for ReadFailure {
    fn assert_scope(&self, selected: &OperationScope) -> Result<()> {
        need(selected == &scope(), "SCOPE")?;
        if self.count.fetch_add(1, Ordering::SeqCst) == 0 {
            return Ok(());
        }
        let cause = fs::read(&self.path).unwrap_err();
        Err(JournalError::guard_failure(
            "OWNED_NATIVE_READ_FAILED",
            cause,
        ))
    }
}
#[test]
fn actual_guard_read_failure_and_checked_lock_close_both_survive_the_error_seam() {
    use std::error::Error;
    let tree = Tree::new();
    let initialized = tree.initialized();
    initialized.close().unwrap();
    let guard = Arc::new(ReadFailure {
        count: AtomicUsize::new(0),
        path: tree.root.join("missing-owned-native-fact"),
    });
    let store = OperationStore::open(&tree.root, guard, None).unwrap();
    faults::STATE.with(|value| value.borrow_mut().close = Some(CloseRole::Lock));
    let error = store.snapshot(&scope()).unwrap_err();
    assert_eq!(error.code(), "OWNED_NATIVE_READ_FAILED");
    assert!(error.source().is_some());
    let JournalError::Finalization { primary, secondary } = error else {
        panic!("both failures must remain accessible");
    };
    let JournalError::ScopeGuard { code, cause } = *primary else {
        panic!("typed guard source must be retained");
    };
    assert_eq!(code, "OWNED_NATIVE_READ_FAILED");
    assert!(cause.to_string().contains("No such file"));
    assert!(matches!(*secondary, JournalError::Filesystem(_)));
    assert_eq!(
        tree.descriptor_count(),
        1,
        "the real lock fd closed despite finalizer refusal"
    );
    store.close().unwrap();
    assert_eq!(tree.descriptor_count(), 0);
}
