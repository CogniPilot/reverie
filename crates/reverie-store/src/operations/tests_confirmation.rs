use super::*;
#[test]
fn confirmation_uses_held_canonical_reader_and_installed_observer_without_phase_tightening() {
    let tree = Tree::new();
    let store = tree.initialized();
    let (view, handle) = tree.claim(&store);
    store
        .begin_effect(&scope(), &handle, Effect::Prepare, version(1))
        .unwrap();
    let before = tree.raw();
    let calls = tree.observer.calls.load(Ordering::SeqCst);
    let document = store.confirm_claim(&scope(), &view).unwrap();
    assert_eq!(
        document
            .operations()
            .get(&view.record().data().id)
            .unwrap()
            .data()
            .state,
        OperationState::Preparing
    );
    assert_eq!(tree.observer.calls.load(Ordering::SeqCst), calls + 1);
    assert_eq!(
        tree.raw(),
        before,
        "confirmation observes only; it does not edit or remint a handle"
    );
    store.close().unwrap();
    assert_eq!(tree.descriptor_count(), 0);
}
#[test]
fn changed_selected_fields_refuse_before_installed_observer_and_observation_drift_after_them() {
    let tree = Tree::new();
    let store = tree.initialized();
    let (view, _) = tree.claim(&store);
    let document = store.snapshot(&scope()).unwrap();
    let mut data = view.record().data().clone();
    data.reservation_id = id(17);
    let changed = document
        .replacing(Operation::try_new(data).unwrap())
        .unwrap();
    fs::write(
        tree.root.join("operations.json"),
        operations_v1::encode(&changed).unwrap(),
    )
    .unwrap();
    let calls = tree.observer.calls.load(Ordering::SeqCst);
    assert_eq!(
        store.confirm_claim(&scope(), &view).unwrap_err().code(),
        "RESERVATION_CLAIM_CHANGED"
    );
    assert_eq!(
        tree.observer.calls.load(Ordering::SeqCst),
        calls,
        "selected row comparison precedes native observer"
    );
    fs::write(
        tree.root.join("operations.json"),
        operations_v1::encode(&document).unwrap(),
    )
    .unwrap();
    tree.observer.change_at.store(calls + 1, Ordering::SeqCst);
    assert_eq!(
        store.confirm_claim(&scope(), &view).unwrap_err().code(),
        "RESERVATION_APPROVED_PROFILE_CHANGED"
    );
    store.close().unwrap();
    assert_eq!(tree.descriptor_count(), 0);
}
#[test]
fn preparation_confirmation_is_exact_but_terminal_reader_allows_unrelated_valid_rows() {
    let tree = Tree::new();
    let store = tree.initialized();
    let (reserved, handle) = tree.claim(&store);
    let preparing = store
        .begin_effect(&scope(), &handle, Effect::Prepare, version(1))
        .unwrap();
    let calls = tree.observer.calls.load(Ordering::SeqCst);
    assert_eq!(
        store
            .confirm_preparation(&scope(), &reserved)
            .unwrap_err()
            .code(),
        "RESOURCE_PREPARATION_CLAIM_CHANGED"
    );
    assert_eq!(
        tree.observer.calls.load(Ordering::SeqCst),
        calls,
        "exact phase selection precedes native observer"
    );
    store
        .confirm_claim(&scope(), &reserved)
        .expect("ordinary claim confirmation keeps its legacy selected-field contract");
    store.confirm_preparation(&scope(), &preparing).unwrap();
    let old = store.snapshot(&scope()).unwrap();
    store
        .claim(
            &scope(),
            &id(21),
            &request(id(12), 32),
            &ClaimSelection::default(),
        )
        .unwrap();
    assert_eq!(store.snapshot(&scope()).unwrap().operations().len(), 2);
    let stamp = tree
        .open()
        .into_preparation_terminal_stamp(&scope(), &preparing)
        .unwrap();
    stamp.assert_preparation_named_current().unwrap();
    assert_eq!(
        tree.descriptor_count(),
        1,
        "fresh terminal reader and flock close; only the original retained store stays open"
    );
    assert_eq!(
        tree.open()
            .into_exact_terminal_stamp(&scope(), &old)
            .err()
            .unwrap()
            .code(),
        "RESERVATION_CLAIM_CHANGED",
        "ordinary exact-document reader is unchanged"
    );
    store.close().unwrap();
    assert_eq!(tree.descriptor_count(), 0);
}
