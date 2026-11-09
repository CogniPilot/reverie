//! Real refused origin prefixes only; successful joined OS/daemon/image
//! qualification is not synthesized by these ownership controls.
use super::*;
#[test]
fn equal_revalidated_snapshot_and_foreign_nominee_cannot_replace_original_binding() {
    crate::test_process::owning_case!(
        equal_revalidated_snapshot_and_foreign_nominee_cannot_replace_original_binding
    );
    let (root, broker, shared) = unopened();
    let snapshot = broker.configuration().unwrap();
    shared.try_owner().unwrap().snapshot = Some(Arc::clone(&snapshot));
    let principal = shared.try_owner().unwrap().request.principal().clone();
    let view = shared.preparation_view(&broker).unwrap();
    let equal = Arc::new(
        crate::worker_validation::validate_captured(snapshot.configuration().clone()).unwrap(),
    );
    let equal_data = reverie_contracts::worker_config::config_digest(snapshot.configuration())
        == reverie_contracts::worker_config::config_digest(equal.configuration());
    let original = view.assert_fleet_preview_binding(&broker, &snapshot, &principal);
    let copied = view.assert_fleet_preview_binding(&broker, &equal, &principal);
    let raw=serde_json::to_vec(&serde_json::json!({"kind":"fleet-preview","purpose":"resource-fleet-maintenance-v1","version":1,
        "requestId":"11111111-2222-4333-8444-555555555555","principal":{"accountId":"bbbbbbbb-cccc-4ddd-8eee-ffffffffffff","personId":"owner","sessionEpoch":3}})).unwrap();
    let request = reverie_contracts::resource_actor::FleetPreviewRequest::decode(
        &reverie_contracts::human_protocol::HumanFrame::decode(&raw).unwrap(),
    )
    .unwrap();
    let foreign = view.assert_fleet_preview_binding(&broker, &snapshot, request.principal());
    drop(view);
    let b_unchanged = shared.preparation_view(&broker).is_ok();
    cleanup(root, broker, shared);
    original.unwrap();
    assert!(equal_data && copied.is_err() && foreign.is_err() && b_unchanged);
}

#[test]
fn dropped_unclosed_failure_keeps_the_original_view_without_b_latch_changes() {
    crate::test_process::owning_case!(
        dropped_unclosed_failure_keeps_the_original_view_without_b_latch_changes
    );
    let (root, broker, shared) = unopened();
    let references = Arc::strong_count(&shared.owner);
    let failure = shared
        .preparation_view(&broker)
        .unwrap()
        .observe_target()
        .err()
        .unwrap();
    drop(failure);
    let retained = Arc::strong_count(&shared.owner) == references + 1;
    let owner = shared.try_owner().unwrap();
    let unchanged = !owner.failed && !owner.registration_attempted && !owner.metadata_closed;
    drop(owner);
    cleanup(root, broker, shared);
    assert!(retained && unchanged);
}

#[test]
fn refused_target_observation_retains_same_view_and_issues_no_target_queries() {
    crate::test_process::owning_case!(
        refused_target_observation_retains_same_view_and_issues_no_target_queries
    );
    let (root, broker, shared) = unopened();
    let before = std::fs::read(root.join("calls.txt")).ok();
    let references = Arc::strong_count(&shared.owner);
    let view = shared.preparation_view(&broker).unwrap();
    let mut failure = view.observe_target().err().unwrap();
    let retained = Arc::strong_count(&shared.owner) == references + 1;
    let first = failure.cause().code();
    let closed = failure.close_components();
    let still_retained = Arc::strong_count(&shared.owner) == references + 1;
    let same_cause = failure.cause().code() == first && failure.cleanup_error().is_none();
    drop(failure);
    let released = Arc::strong_count(&shared.owner) == references;
    let owner = shared.try_owner().unwrap();
    let b_unchanged = !owner.failed && !owner.registration_attempted && !owner.metadata_closed;
    drop(owner);
    let after = std::fs::read(root.join("calls.txt")).ok();
    cleanup(root, broker, shared);
    closed.unwrap();
    assert!(retained && still_retained && released && same_cause && b_unchanged);
    assert_eq!(first, "POOL_INSTALLATION_OFFER_CONFIGURATION_CHANGED");
    assert_eq!(before, after);
}

#[test]
fn missing_native_origin_remains_typed_and_never_becomes_target_data() {
    crate::test_process::owning_case!(
        missing_native_origin_remains_typed_and_never_becomes_target_data
    );
    let (root, broker, shared) = unopened();
    shared.try_owner().unwrap().snapshot = Some(broker.configuration().unwrap());
    let before = std::fs::read(root.join("calls.txt")).ok();
    let view = shared.preparation_view(&broker).unwrap();
    let mut failure = view.observe_target().err().unwrap();
    let native_cause = matches!(failure.cause(),
        OfferTargetObservationError::Offer(cause)
            if matches!(cause.as_ref(), BrokerInstallationOfferCause::NativeOrigin));
    let closed = failure.close_components();
    drop(failure);
    let after = std::fs::read(root.join("calls.txt")).ok();
    let unchanged = !shared.try_owner().unwrap().registration_attempted;
    cleanup(root, broker, shared);
    closed.unwrap();
    assert!(native_cause && unchanged);
    assert_eq!(before, after);
}

#[test]
fn closed_origin_refuses_consumed_view_without_reopening_or_poisoning_b() {
    crate::test_process::owning_case!(
        closed_origin_refuses_consumed_view_without_reopening_or_poisoning_b
    );
    let (root, broker, shared) = unopened();
    let view = shared.preparation_view(&broker).unwrap();
    shared.close_origin_metadata().unwrap();
    let mut failure = view.observe_target().err().unwrap();
    let code = failure.cause().code();
    let closed = failure.close_components();
    drop(failure);
    let owner = shared.try_owner().unwrap();
    let unchanged = !owner.failed && !owner.registration_attempted && owner.metadata_closed;
    drop(owner);
    cleanup(root, broker, shared);
    closed.unwrap();
    assert!(unchanged);
    assert_eq!(code, "POOL_INSTALLATION_OFFER_EXPIRED_OR_CLOSED");
}
