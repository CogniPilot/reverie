use super::*;
#[path = "tests_confirmation.rs"]
mod confirmation_cases;
#[path = "tests_guard_errors.rs"]
mod guard_error_cases;
#[path = "tests_terminal.rs"]
mod terminal_cases;

#[test]
fn actual_python_store_transcript_matches_each_durable_state_and_cold_view() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/operation-journal-store-transcript.json"
    ))
    .unwrap();
    let steps = fixture["steps"].as_array().unwrap();
    assert_eq!(steps.len(), 10);
    let tree = Tree::new();
    let store = tree.initialized();
    transcript_step(&tree, steps, 0);
    let selected = ClaimSelection {
        operation_id: Some(id(8)),
        reservation_id: Some(id(9)),
        reserved_sid: Some(id(10)),
    };
    let (_, handle) = store
        .claim(&scope(), &id(2), &request(id(4), 48), &selected)
        .unwrap();
    let handle = handle.unwrap();
    transcript_step(&tree, steps, 1);
    assert!(
        store
            .claim(&scope(), &id(2), &request(id(4), 48), &selected)
            .unwrap()
            .1
            .is_none()
    );
    transcript_step(&tree, steps, 2);
    for (index, effect) in [Effect::Prepare, Effect::Start, Effect::Verify]
        .into_iter()
        .enumerate()
    {
        let version_number = 1 + 2 * (index as u64);
        store
            .begin_effect(&scope(), &handle, effect, version(version_number))
            .unwrap();
        transcript_step(&tree, steps, 3 + 2 * index);
        store
            .record_ack(
                &scope(),
                &handle,
                effect,
                digest(9),
                version(version_number + 1),
            )
            .unwrap();
        transcript_step(&tree, steps, 4 + 2 * index);
    }
    store.close().unwrap();
    let cold = tree.open();
    let view = cold.lookup(&scope(), &id(2)).unwrap().unwrap();
    transcript_step(&tree, steps, 9);
    assert_eq!(view.state().name(), fixture["coldState"].as_str().unwrap());
    assert_eq!(view.reason(), fixture["coldReason"].as_str());
    assert_eq!(
        view.record().data().version.get(),
        fixture["coldVersion"].as_u64().unwrap()
    );
    assert_eq!(view.verified(), fixture["verified"].as_bool().unwrap());
    assert_eq!(
        view.retry_allowed(),
        fixture["retryAllowed"].as_bool().unwrap()
    );
    assert_eq!(
        view.reservation_retained(),
        fixture["reservationRetained"].as_bool().unwrap()
    );
    cold.close().unwrap();
}
fn transcript_step(tree: &Tree, steps: &[serde_json::Value], index: usize) {
    assert_eq!(
        tree.raw(),
        steps[index]["canonical"].as_str().unwrap().as_bytes(),
        "{}",
        steps[index]["name"]
    );
}
use crate::faults::{self, Point};
use reverie_contracts::operations_v1;
use reverie_core::revision::{Generation, ObservedProfileVersion, ProfileVersion};
use std::os::unix::fs::{MetadataExt, PermissionsExt, symlink};
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
fn id(n: u64) -> JournalId {
    JournalId::parse(&format!("{n:08x}-1111-4111-8111-111111111111")).unwrap()
}
fn digest(n: u8) -> JournalDigest {
    JournalDigest::parse(&format!("{n:x}").repeat(64)).unwrap()
}
fn scope() -> OperationScope {
    OperationScope {
        company_id: id(1),
        owner_scope_digest: digest(1),
    }
}
fn version(n: u64) -> ProfileVersion {
    ProfileVersion::try_new(n).unwrap()
}
fn observation(employee: JournalId) -> CapacityObservation {
    CapacityObservation::try_new(ObservationData {
        pool_id: id(6),
        pool_revision_digest: digest(2),
        budget_bytes: 128 * MIB,
        committed_bytes: 100 * MIB,
        employee_id: employee,
        current_sid: id(7),
        generation: Generation::try_new(1).unwrap(),
        source_binding_digest: digest(3),
        profile_version: ObservedProfileVersion::try_new(1).unwrap(),
        current_memory_bytes: MemoryBytes::try_new(32 * MIB).unwrap(),
    })
    .unwrap()
}
fn request(employee: JournalId, requested: u64) -> OperationRequest {
    let o = observation(employee.clone());
    OperationRequest {
        employee_id: employee,
        pool_id: id(6),
        source_binding_digest: digest(3),
        profile_version: ObservedProfileVersion::try_new(1).unwrap(),
        requested_memory_bytes: MemoryBytes::try_new(requested * MIB).unwrap(),
        preview_digest: digest(4),
        observation_digest: operations_v1::observation_digest(&o),
    }
}
#[derive(Default)]
struct Guard {
    denied: AtomicBool,
    calls: AtomicUsize,
    fail_at: AtomicUsize,
}
impl ScopeGuard for Guard {
    fn assert_scope(&self, _: &OperationScope) -> Result<()> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        need(
            !self.denied.load(Ordering::SeqCst) && self.fail_at.load(Ordering::SeqCst) != call,
            "OWNER_REVOKED",
        )
    }
}
#[derive(Default)]
struct Observer {
    calls: AtomicUsize,
    change_at: AtomicUsize,
}
impl CapacityObserver for Observer {
    fn observe(
        &self,
        _: &OperationScope,
        pool: &JournalId,
        employee: &JournalId,
    ) -> Result<CapacityObservation> {
        assert_eq!(pool, &id(6));
        let call = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        let mut data = observation(employee.clone()).data().clone();
        let changed = self.change_at.load(Ordering::SeqCst);
        if changed != 0 && call >= changed {
            data.pool_revision_digest = digest(5);
        }
        Ok(CapacityObservation::try_new(data)?)
    }
}
struct Tree {
    root: PathBuf,
    guard: Arc<Guard>,
    observer: Arc<Observer>,
}
impl Tree {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "reverie-operations-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        Self {
            root,
            guard: Arc::new(Guard::default()),
            observer: Arc::new(Observer::default()),
        }
    }
    fn open(&self) -> OperationStore {
        OperationStore::open(&self.root, self.guard.clone(), Some(self.observer.clone())).unwrap()
    }
    fn initialized(&self) -> OperationStore {
        let store = self.open();
        store.initialize(&scope()).unwrap();
        self.guard.calls.store(0, Ordering::SeqCst);
        store
    }
    fn raw(&self) -> Vec<u8> {
        fs::read(self.root.join("operations.json")).unwrap()
    }
    fn claim(&self, store: &OperationStore) -> (OperationView, OperationHandle) {
        let (view, handle) = store
            .claim(
                &scope(),
                &id(2),
                &request(id(4), 48),
                &ClaimSelection::default(),
            )
            .unwrap();
        (view, handle.unwrap())
    }
    fn descriptor_count(&self) -> usize {
        fs::read_dir("/proc/self/fd")
            .unwrap()
            .filter_map(|entry| fs::read_link(entry.unwrap().path()).ok())
            .filter(|path| path.starts_with(&self.root))
            .count()
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        faults::reset();
        fs::remove_dir_all(&self.root).unwrap();
    }
}

#[test]
fn durable_claim_replay_and_restart_never_reissue_a_handle() {
    let tree = Tree::new();
    let store = tree.initialized();
    assert!(store.lookup(&scope(), &id(2)).unwrap().is_none());
    let (first, handle) = tree.claim(&store);
    assert_eq!(first.record().data().delta_bytes, 16 * MIB);
    let before = tree.raw();
    let (replay, none) = store
        .claim(
            &scope(),
            &id(2),
            &request(id(4), 48),
            &ClaimSelection::default(),
        )
        .unwrap();
    assert_eq!(first, replay);
    assert!(none.is_none());
    assert_eq!(tree.raw(), before);
    assert_eq!(tree.observer.calls.load(Ordering::SeqCst), 3);
    store.close().unwrap();
    let cold = tree.open();
    let view = cold.lookup(&scope(), &id(2)).unwrap().unwrap();
    assert_eq!(view.state(), OperationState::RecoveryRequired);
    assert!(!view.retry_allowed() && !view.verified() && view.reservation_retained());
    assert_eq!(
        cold.begin_effect(&scope(), &handle, Effect::Prepare, version(1))
            .unwrap_err()
            .code(),
        "MISSING_ACTIVE_CLAIM"
    );
    cold.close().unwrap();
    assert_eq!(tree.descriptor_count(), 0);
}

#[test]
fn phases_and_ack_hashes_never_verify_or_release_capacity() {
    let tree = Tree::new();
    let store = tree.initialized();
    let (_, handle) = tree.claim(&store);
    for (index, effect) in [Effect::Prepare, Effect::Start, Effect::Verify]
        .into_iter()
        .enumerate()
    {
        let v = 1 + (index as u64) * 2;
        assert!(
            !store
                .begin_effect(&scope(), &handle, effect, version(v))
                .unwrap()
                .verified()
        );
        let view = store
            .record_ack(&scope(), &handle, effect, digest(9), version(v + 1))
            .unwrap();
        assert!(!view.verified() && view.reservation_retained());
    }
    let error = store
        .claim(
            &scope(),
            &id(3),
            &request(id(5), 48),
            &ClaimSelection::default(),
        )
        .err()
        .unwrap();
    assert_eq!(error.code(), "CAPACITY_EXHAUSTED");
    store.close().unwrap();
}

#[test]
fn changed_replay_wrong_scope_stale_version_and_uncertainty_are_fenced() {
    let tree = Tree::new();
    let store = tree.initialized();
    let (_, handle) = tree.claim(&store);
    assert_eq!(
        store
            .claim(
                &scope(),
                &id(2),
                &request(id(4), 47),
                &ClaimSelection::default()
            )
            .err()
            .unwrap()
            .code(),
        "IDEMPOTENCY_CONFLICT"
    );
    assert_eq!(
        store
            .begin_effect(&scope(), &handle, Effect::Start, version(1))
            .unwrap_err()
            .code(),
        "EFFECT_ALREADY_ATTEMPTED_OR_OUT_OF_ORDER"
    );
    assert_eq!(
        store
            .begin_effect(&scope(), &handle, Effect::Prepare, version(2))
            .unwrap_err()
            .code(),
        "STALE_OPERATION_VERSION"
    );
    let view = store
        .mark_uncertain(
            &scope(),
            &handle,
            version(1),
            RecoveryReason::parse("LOST_ACK").unwrap(),
        )
        .unwrap();
    assert_eq!(view.state(), OperationState::RecoveryRequired);
    assert_eq!(
        store
            .begin_effect(&scope(), &handle, Effect::Prepare, version(2))
            .unwrap_err()
            .code(),
        "MISSING_ACTIVE_CLAIM"
    );
    assert_eq!(store.snapshot(&scope()).unwrap().operations().len(), 1);
    store.close().unwrap();
}

#[test]
fn initialize_is_explicit_and_never_erases_or_maps_missing_to_absent() {
    let tree = Tree::new();
    let store = tree.open();
    assert!(store.lookup(&scope(), &id(2)).is_err());
    store.initialize(&scope()).unwrap();
    let before = tree.raw();
    assert!(store.initialize(&scope()).is_err());
    assert_eq!(tree.raw(), before);
    fs::remove_file(tree.root.join("operations.json")).unwrap();
    assert!(store.lookup(&scope(), &id(2)).is_err());
    fs::write(tree.root.join("operations.json"), b"{}").unwrap();
    fs::set_permissions(
        tree.root.join("operations.json"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    assert!(store.lookup(&scope(), &id(2)).is_err());
    store.close().unwrap();
}

#[test]
fn private_file_alias_link_mode_and_fifo_refuse_without_blocking() {
    let tree = Tree::new();
    let store = tree.initialized();
    let file = tree.root.join("operations.json");
    fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(
        store.lookup(&scope(), &id(2)).unwrap_err().code(),
        "PRIVATE_FILE"
    );
    fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
    fs::hard_link(&file, tree.root.join("linked")).unwrap();
    assert!(store.lookup(&scope(), &id(2)).is_err());
    fs::remove_file(&file).unwrap();
    symlink(tree.root.join("linked"), &file).unwrap();
    assert!(store.lookup(&scope(), &id(2)).is_err());
    fs::remove_file(&file).unwrap();
    private_fs::fifo(&file);
    assert!(store.lookup(&scope(), &id(2)).is_err());
    store.close().unwrap();
}

#[test]
fn capacity_before_install_refuses_and_after_install_is_uncertain() {
    for change_at in [2, 3] {
        let tree = Tree::new();
        let store = tree.initialized();
        tree.observer.change_at.store(change_at, Ordering::SeqCst);
        let error = store
            .claim(
                &scope(),
                &id(2),
                &request(id(4), 48),
                &ClaimSelection::default(),
            )
            .err()
            .unwrap();
        assert_eq!(error.is_uncertain(), change_at == 3);
        assert_eq!(
            store.snapshot(&scope()).unwrap().operations().len(),
            usize::from(change_at == 3)
        );
        store.close().unwrap();
    }
}

#[test]
fn rename_sync_and_lock_close_ack_loss_retain_claims_and_revoke_handles() {
    for point in [Point::AfterRename, Point::DirectorySync] {
        let tree = Tree::new();
        let store = tree.initialized();
        inject_failure(point);
        let error = store
            .claim(
                &scope(),
                &id(2),
                &request(id(4), 48),
                &ClaimSelection::default(),
            )
            .err()
            .unwrap();
        assert!(error.is_uncertain());
        faults::reset();
        let view = store.lookup(&scope(), &id(2)).unwrap().unwrap();
        assert_eq!(view.state(), OperationState::RecoveryRequired);
        assert!(
            store
                .claim(
                    &scope(),
                    &id(2),
                    &request(id(4), 48),
                    &ClaimSelection::default()
                )
                .unwrap()
                .1
                .is_none()
        );
        store.close().unwrap();
    }
    let tree = Tree::new();
    let store = tree.initialized();
    faults::STATE.with(|state| state.borrow_mut().close = Some(CloseRole::Lock));
    assert!(
        store
            .claim(
                &scope(),
                &id(2),
                &request(id(4), 48),
                &ClaimSelection::default()
            )
            .err()
            .unwrap()
            .is_uncertain()
    );
    store.close().unwrap();
}

#[test]
fn scope_revocation_after_publication_is_uncertain() {
    let tree = Tree::new();
    let store = tree.initialized();
    tree.guard.fail_at.store(4, Ordering::SeqCst);
    let error = store
        .claim(
            &scope(),
            &id(2),
            &request(id(4), 48),
            &ClaimSelection::default(),
        )
        .err()
        .unwrap();
    assert!(error.is_uncertain());
    tree.guard.fail_at.store(0, Ordering::SeqCst);
    assert_eq!(store.snapshot(&scope()).unwrap().operations().len(), 1);
    store.close().unwrap();
}

#[test]
fn partial_writes_complete_but_zero_writes_never_install() {
    let tree = Tree::new();
    let store = tree.initialized();
    faults::STATE.with(|state| state.borrow_mut().write_limit = Some(1));
    let (_, handle) = tree.claim(&store);
    let before = tree.raw();
    faults::STATE.with(|state| state.borrow_mut().write_limit = Some(0));
    let error = store
        .begin_effect(&scope(), &handle, Effect::Prepare, version(1))
        .unwrap_err();
    assert!(!error.is_uncertain());
    assert_eq!(tree.raw(), before);
    faults::reset();
    assert_eq!(
        fs::metadata(tree.root.join("operations.json"))
            .unwrap()
            .mode()
            & 0o777,
        0o600
    );
    store.close().unwrap();
}

#[test]
fn prepared_foreign_replacement_is_retained_and_original_inode_is_pinned() {
    let tree = Tree::new();
    let store = tree.initialized();
    faults::STATE.with(|state| state.borrow_mut().hook = Some(Box::new(replace_prepared)));
    let error = store
        .claim(
            &scope(),
            &id(2),
            &request(id(4), 48),
            &ClaimSelection::default(),
        )
        .err()
        .unwrap();
    assert!(!error.is_uncertain());
    faults::reset();
    let retained = fs::read_dir(&tree.root)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            path.file_name()
                .unwrap()
                .as_encoded_bytes()
                .starts_with(b".operation-")
        })
        .unwrap();
    assert_eq!(fs::read(retained).unwrap(), b"foreign");
    assert_eq!(store.snapshot(&scope()).unwrap().operations().len(), 0);
    store.close().unwrap();
}
fn inject_failure(expected: Point) {
    faults::STATE.with(|state| {
        state.borrow_mut().hook = Some(Box::new(move |point, _| fail_at(point, expected)))
    });
}
fn fail_at(point: Point, expected: Point) -> crate::error::Result<()> {
    if point == expected {
        Err(crate::StoreError::io(std::io::Error::other("lost ACK")))
    } else {
        Ok(())
    }
}
fn replace_prepared(point: Point, path: &std::path::Path) -> crate::error::Result<()> {
    if point != Point::AfterTemporaryPrepared {
        return Ok(());
    }
    let temporary = fs::read_dir(path)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            path.file_name()
                .unwrap()
                .as_encoded_bytes()
                .starts_with(b".operation-")
        })
        .unwrap();
    let original = fs::metadata(&temporary).unwrap();
    fs::remove_file(&temporary).unwrap();
    let pinned = fs::read_dir("/proc/self/fd")
        .unwrap()
        .filter_map(|entry| fs::metadata(entry.unwrap().path()).ok())
        .any(|info| info.dev() == original.dev() && info.ino() == original.ino());
    assert!(pinned);
    fs::write(&temporary, b"foreign").unwrap();
    Ok(())
}

#[test]
fn shared_directory_early_refusal_and_enumeration_closes_retain_evidence() {
    faults::STATE.with(|state| state.borrow_mut().close = Some(CloseRole::Walk));
    assert!(matches!(
        Directory::open(std::path::Path::new("/")),
        Err(crate::StoreError::Finalization { .. })
    ));
    faults::reset();
    let tree = Tree::new();
    fs::write(tree.root.join("operations.lock"), b"").unwrap();
    let directory = Directory::open(&tree.root).unwrap();
    faults::STATE.with(|state| state.borrow_mut().close = Some(CloseRole::Walk));
    let error = directory.check().unwrap_err();
    assert_eq!(error.code(), "STORE_DIRECTORY_REBOUND");
    assert!(
        matches!(error,crate::StoreError::DirectoryRecheck{cause} if matches!(*cause,crate::StoreError::Io{..}))
    );
    faults::STATE.with(|state| state.borrow_mut().close = Some(CloseRole::Walk));
    assert!(directory.only_lock_leaf("operations.lock").is_err());
    directory.close().unwrap();
    assert_eq!(tree.descriptor_count(), 0);
}

#[test]
fn guarded_lookup_scope_global_employee_and_shrink_accounting_remain_distinct() {
    let tree = Tree::new();
    let store = tree.initialized();
    let (view, handle) = store
        .claim(
            &scope(),
            &id(2),
            &request(id(4), 16),
            &ClaimSelection::default(),
        )
        .unwrap();
    let handle = handle.unwrap();
    assert_eq!(view.record().data().delta_bytes, 0);
    let other = OperationScope {
        owner_scope_digest: digest(9),
        ..scope()
    };
    assert!(store.lookup(&other, &id(2)).unwrap().is_none());
    assert_eq!(
        store
            .begin_effect(&other, &handle, Effect::Prepare, version(1))
            .unwrap_err()
            .code(),
        "CLAIM_SCOPE"
    );
    assert_eq!(
        store
            .claim(
                &other,
                &id(3),
                &request(id(4), 48),
                &ClaimSelection::default()
            )
            .err()
            .unwrap()
            .code(),
        "EMPLOYEE_HAS_RETAINED_CLAIM"
    );
    assert_eq!(
        store
            .claim(
                &other,
                &id(3),
                &request(id(5), 64),
                &ClaimSelection::default()
            )
            .err()
            .unwrap()
            .code(),
        "CAPACITY_EXHAUSTED"
    );
    store.close().unwrap();
    let readonly = OperationStore::open(&tree.root, tree.guard.clone(), None).unwrap();
    assert!(
        readonly
            .claim(
                &scope(),
                &id(2),
                &request(id(4), 16),
                &ClaimSelection::default()
            )
            .unwrap()
            .1
            .is_none()
    );
    assert_eq!(
        readonly
            .claim(
                &scope(),
                &id(3),
                &request(id(5), 48),
                &ClaimSelection::default()
            )
            .err()
            .unwrap()
            .code(),
        "MISSING_CAPACITY_OBSERVER"
    );
    readonly.close().unwrap();
}

#[test]
fn failed_uncertainty_transition_still_revokes_the_original_local_handle() {
    let tree = Tree::new();
    let store = tree.initialized();
    let (_, handle) = tree.claim(&store);
    let before = tree.raw();
    assert_eq!(
        store
            .mark_uncertain(
                &scope(),
                &handle,
                version(2),
                RecoveryReason::parse("UNKNOWN").unwrap()
            )
            .unwrap_err()
            .code(),
        "STALE_OPERATION_VERSION"
    );
    assert_eq!(tree.raw(), before);
    assert_eq!(
        store.lookup(&scope(), &id(2)).unwrap().unwrap().state(),
        OperationState::RecoveryRequired
    );
    assert_eq!(
        store
            .begin_effect(&scope(), &handle, Effect::Prepare, version(1))
            .unwrap_err()
            .code(),
        "MISSING_ACTIVE_CLAIM"
    );
    store.close().unwrap();
}

#[test]
fn fixed_preselected_role_ids_are_bound_on_replay_and_never_reallocated() {
    let tree = Tree::new();
    let store = tree.initialized();
    let selected = ClaimSelection {
        operation_id: Some(id(30)),
        reservation_id: Some(id(31)),
        reserved_sid: Some(id(32)),
    };
    let (view, _) = store
        .claim(&scope(), &id(2), &request(id(4), 48), &selected)
        .unwrap();
    assert_eq!(view.record().data().id, id(30));
    assert_eq!(view.record().data().reservation_id, id(31));
    assert_eq!(view.record().data().reserved_sid, id(32));
    assert!(
        store
            .claim(&scope(), &id(2), &request(id(4), 48), &selected)
            .unwrap()
            .1
            .is_none()
    );
    let conflict = ClaimSelection {
        reserved_sid: Some(id(33)),
        ..selected
    };
    assert_eq!(
        store
            .claim(&scope(), &id(2), &request(id(4), 48), &conflict)
            .err()
            .unwrap()
            .code(),
        "IDEMPOTENCY_CONFLICT"
    );
    store.close().unwrap();
}

#[test]
fn lock_swap_before_publication_refuses_and_same_bytes_data_swap_after_finalizer_is_uncertain() {
    for after in [false, true] {
        let tree = Tree::new();
        let store = tree.initialized();
        let before = tree.raw();
        inject_replacement(after);
        let error = store
            .claim(
                &scope(),
                &id(2),
                &request(id(4), 48),
                &ClaimSelection::default(),
            )
            .err()
            .unwrap();
        assert_eq!(error.is_uncertain(), after);
        faults::reset();
        if !after {
            assert_eq!(tree.raw(), before);
        } else {
            assert_eq!(
                store.lookup(&scope(), &id(2)).unwrap().unwrap().state(),
                OperationState::RecoveryRequired
            );
        }
        store.close().unwrap();
    }
}
fn inject_replacement(after: bool) {
    faults::STATE.with(|state| {
        state.borrow_mut().hook = Some(Box::new(move |point, path| {
            replace_named(point, path, after)
        }))
    });
}
fn replace_named(point: Point, path: &std::path::Path, after: bool) -> crate::error::Result<()> {
    let expected = if after {
        Point::AfterTemporaryCleanup
    } else {
        Point::AfterTemporaryPrepared
    };
    if point != expected {
        return Ok(());
    }
    let leaf = path.join(if after {
        "operations.json"
    } else {
        "operations.lock"
    });
    let bytes = fs::read(&leaf).unwrap();
    fs::rename(&leaf, leaf.with_extension("saved")).unwrap();
    fs::write(&leaf, bytes).unwrap();
    fs::set_permissions(&leaf, fs::Permissions::from_mode(0o600)).unwrap();
    Ok(())
}

#[test]
fn only_test_sealed_completion_can_reach_completed_and_fences_repeat() {
    let tree = Tree::new();
    let store = tree.initialized();
    let (_, handle) = tree.claim(&store);
    for (index, effect) in [Effect::Prepare, Effect::Start, Effect::Verify]
        .into_iter()
        .enumerate()
    {
        let v = 1 + (index as u64) * 2;
        store
            .begin_effect(&scope(), &handle, effect, version(v))
            .unwrap();
        store
            .record_ack(&scope(), &handle, effect, digest(8), version(v + 1))
            .unwrap();
    }
    let op = store.snapshot(&scope()).unwrap().operations()[handle.operation_id()].clone();
    let count = Arc::new(AtomicUsize::new(0));
    let calls = count.clone();
    let proof = completion::fixture(&store, scope(), op, digest(9), move || {
        calls.fetch_add(1, Ordering::SeqCst);
        Ok(())
    });
    let view = store
        .complete_native(&scope(), &handle, &proof, version(7))
        .unwrap();
    assert_eq!(view.state(), OperationState::Completed);
    assert!(view.reservation_retained() && !view.verified());
    assert_eq!(count.load(Ordering::SeqCst), 3);
    store.close().unwrap();
}
