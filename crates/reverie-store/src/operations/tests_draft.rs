use super::*;
use reverie_contracts::reservation_observation::{
    ReservationObservation, ReservationObservationFields,
};
use reverie_core::{
    decimal::UnsignedInteger,
    ids::{ProfileEmployeeId, ProfileSessionId},
};
struct FixedDraft {
    root: PathBuf,
    calls: AtomicUsize,
}
impl DraftObserver for FixedDraft {
    fn observe_draft(
        &self,
        selected: &OperationScope,
        document: &OperationDocument,
    ) -> Result<DraftObservation> {
        assert_eq!(selected, &scope());
        assert!(document.operations().is_empty());
        // A separately opened descriptor must fail to acquire the actual
        // canonical flock during this observer, even in the same process.
        let directory = Directory::open(&self.root)?;
        let locked = directory
            .lock_named("operations.lock")
            .expect_err("journal lock held");
        assert!(matches!(
            locked,
            crate::StoreError::Io {
                fault: crate::StoreFault::LockBusy,
                ..
            }
        ));
        directory.close()?;
        self.calls.fetch_add(1, Ordering::SeqCst);
        let data = observation(id(4));
        let data = data.data();
        Ok(DraftObservation {
            observation: ReservationObservation::try_new(ReservationObservationFields {
                pool: data.pool_id.clone(),
                pool_revision: data.pool_revision_digest.clone(),
                budget_bytes: data.budget_bytes,
                committed_bytes: data.committed_bytes,
                employee: ProfileEmployeeId::parse(data.employee_id.as_str()).unwrap(),
                current_session: ProfileSessionId::parse("00000000-0000-0000-0000-000000000000")
                    .unwrap(),
                generation: data.generation,
                source_binding: data.source_binding_digest.clone(),
                profile_version: ProfileVersion::try_new(1).unwrap(),
                current_memory: data.current_memory_bytes,
            })?,
            retained_bytes: UnsignedInteger::from_u64(0),
        })
    }
}
#[test]
fn fixed_draft_observer_runs_under_real_flock_and_retains_nil_preview_data_without_claim() {
    let tree = Tree::new();
    tree.initialized().close().unwrap();
    let before = tree.raw();
    let observer = Arc::new(FixedDraft {
        root: tree.root.clone(),
        calls: AtomicUsize::new(0),
    });
    let store =
        OperationStore::open_draft(&tree.root, tree.guard.clone(), observer.clone()).unwrap();
    let snapshot = store.observe_draft(&scope()).unwrap();
    assert!(snapshot.document().operations().is_empty());
    assert_eq!(
        snapshot.observation().fields().current_session.as_str(),
        "00000000-0000-0000-0000-000000000000"
    );
    assert!(
        snapshot.observation().journal_data().is_err(),
        "preview data cannot silently become claim identities"
    );
    assert_eq!(observer.calls.load(Ordering::SeqCst), 1);
    assert_eq!(tree.raw(), before);
    store.close().unwrap();
    assert_eq!(tree.descriptor_count(), 0);
    let directory = Directory::open(&tree.root).unwrap();
    let lock = directory
        .lock_named("operations.lock")
        .expect("lock closed before success acknowledgement");
    private_fs::close(lock, CloseRole::Lock, &tree.root).unwrap();
    directory.close().unwrap();
}
