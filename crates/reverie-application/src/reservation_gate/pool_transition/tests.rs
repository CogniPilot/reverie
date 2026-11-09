use super::*;
use crate::reservation_gate::tests::{Tree, observation_cases::Setup};
use crate::reservation_observer::tests::Fixture;
use reverie_contracts::worker_config;
use reverie_core::{ids::ProfileSessionId, operations::JournalDigest};
use std::{fs, os::unix::fs::MetadataExt, time::Duration};
mod queued;

fn prepared() -> (Setup, Arc<Fixture>, ReservationGate) {
    let setup = Setup::new();
    let fixture = Fixture::new();
    fixture.storage_facts(setup.stats);
    for _ in 0..180 {
        fixture.inventory(&setup.rows);
    }
    let gate = setup.tree.gate(&fixture, true);
    (setup, fixture, gate)
}
fn selection(gate: &ReservationGate) -> PoolTransitionSelection {
    PoolTransitionSelection::new(
        JournalId::parse("aaaaaaaa-0000-4000-8000-000000000001").unwrap(),
        JournalId::parse("aaaaaaaa-0000-4000-8000-000000000002").unwrap(),
        JournalDigest::parse(&"a".repeat(64)).unwrap(),
        JournalDigest::parse(&"b".repeat(64)).unwrap(),
        JournalDigest::parse(&"c".repeat(64)).unwrap(),
        JournalDigest::parse(
            &worker_config::config_digest(gate.inner.config().unwrap().configuration()).to_hex(),
        )
        .unwrap(),
    )
}
fn pending(tree: &Tree) -> PathBuf {
    tree.root.join("state/resource-reservation-control.pending")
}
fn session(setup: &Setup) -> ProfileSessionId {
    ProfileSessionId::parse(setup.oracle["employee"]["sessionId"].as_str().unwrap()).unwrap()
}
fn assert_blocked(gate: &ReservationGate, selected: &ProfileSessionId) {
    assert_eq!(
        gate.admit_ordinary_launch(selected, AdmissionBounds::default())
            .err()
            .unwrap()
            .code(),
        "POOL_TRANSITION_REQUIRES_RECONCILIATION"
    );
    assert_eq!(
        gate.admit_recovery().err().unwrap().code(),
        "POOL_TRANSITION_REQUIRES_RECONCILIATION"
    );
}

#[test]
fn established_pending_blocks_every_sid_and_shutdown_without_changing_existing_stores() {
    crate::test_process::owning_case!(
        established_pending_blocks_every_sid_and_shutdown_without_changing_existing_stores
    );
    let (setup, fixture, gate) = prepared();
    let journal = setup.tree.root.join("control/operations/operations.json");
    let profiles = setup.tree.root.join("control/profiles/profiles.json");
    let marker = setup
        .tree
        .root
        .join("state/resource-reservation-control.json");
    let original = [&journal, &profiles, &marker].map(|path| fs::read(path).unwrap());
    let selected = selection(&gate);
    let fence = gate
        .establish_pool_transition(&selected, AdmissionBounds::default())
        .unwrap()
        .assert_current()
        .unwrap();
    assert_eq!(
        fence.operation_id().as_str(),
        "aaaaaaaa-0000-4000-8000-000000000001"
    );
    let bytes = fs::read(pending(&setup.tree)).unwrap();
    assert!(
        String::from_utf8(bytes.clone())
            .unwrap()
            .contains("reverie-pool-transition-pending-v1")
    );
    let before = fixture.events().len();
    for sid in [
        session(&setup),
        ProfileSessionId::parse("bbbbbbbb-0000-4000-8000-000000000001").unwrap(),
    ] {
        assert_blocked(&gate, &sid);
    }
    assert_eq!(
        fixture.events().len(),
        before,
        "fenced entry admits no native query"
    );
    assert_eq!(
        gate.settle_owned(Instant::now() + Duration::from_secs(2))
            .unwrap_err()
            .code(),
        "POOL_TRANSITION_REQUIRES_RECONCILIATION"
    );
    drop(fence);
    assert_eq!(fs::read(pending(&setup.tree)).unwrap(), bytes);
    assert_eq!(
        [&journal, &profiles, &marker].map(|path| fs::read(path).unwrap()),
        original
    );
}

#[test]
fn dropping_owner_and_restart_or_removed_option_never_bypass_durable_pending() {
    crate::test_process::owning_case!(
        dropping_owner_and_restart_or_removed_option_never_bypass_durable_pending
    );
    let (setup, fixture, gate) = prepared();
    let fence = gate
        .establish_pool_transition(&selection(&gate), AdmissionBounds::default())
        .unwrap();
    drop(fence);
    assert_blocked(&gate, &session(&setup));
    let snapshot =
        crate::worker_validation::load_owner_config(&setup.tree.root.join("worker.json")).unwrap();
    assert_eq!(
        ReservationGate::new(snapshot, fixture.observer())
            .err()
            .unwrap()
            .code(),
        "RESERVATION_INSTALL_REQUIRES_RECONCILIATION"
    );
    let mut value: serde_json::Value = serde_json::from_slice(&setup.tree.raw).unwrap();
    value
        .as_object_mut()
        .unwrap()
        .remove("resourceReservations");
    let removed = ReservationConfiguration::capture(
        worker_config::decode(&serde_json::to_vec(&value).unwrap()).unwrap(),
    );
    assert!(reservation_control::prior_control_present(&removed).unwrap());
}

#[test]
fn foreign_pending_is_preserved_and_stale_revision_refuses_before_publication() {
    crate::test_process::owning_case!(
        foreign_pending_is_preserved_and_stale_revision_refuses_before_publication
    );
    let (setup, _fixture, gate) = prepared();
    let other = PoolTransitionSelection::new(
        JournalId::parse("aaaaaaaa-0000-4000-8000-000000000001").unwrap(),
        JournalId::parse("aaaaaaaa-0000-4000-8000-000000000002").unwrap(),
        JournalDigest::parse(&"a".repeat(64)).unwrap(),
        JournalDigest::parse(&"b".repeat(64)).unwrap(),
        JournalDigest::parse(&"c".repeat(64)).unwrap(),
        JournalDigest::parse(&"d".repeat(64)).unwrap(),
    );
    assert_eq!(
        gate.establish_pool_transition(&other, AdmissionBounds::default())
            .err()
            .unwrap()
            .cause()
            .code(),
        "RESERVATION_DOMAIN_CHANGED"
    );
    assert!(!pending(&setup.tree).exists());
    assert!(gate.inner.pool_transition.lock().unwrap().is_none());
    setup.tree.write(
        "state/resource-reservation-control.pending",
        b"foreign preserved intent",
    );
    let info = fs::symlink_metadata(pending(&setup.tree)).unwrap();
    let error = gate
        .establish_pool_transition(&selection(&gate), AdmissionBounds::default())
        .err()
        .unwrap();
    assert_eq!(
        error.cause().code(),
        "RESERVATION_INSTALL_REQUIRES_RECONCILIATION"
    );
    let after = fs::symlink_metadata(pending(&setup.tree)).unwrap();
    assert_eq!((info.dev(), info.ino()), (after.dev(), after.ino()));
    assert_eq!(
        fs::read(pending(&setup.tree)).unwrap(),
        b"foreign preserved intent"
    );
}

#[test]
fn original_admission_serializes_establishment_and_same_sid_reentry_is_fenced() {
    crate::test_process::owning_case!(
        original_admission_serializes_establishment_and_same_sid_reentry_is_fenced
    );
    let (setup, _fixture, gate) = prepared();
    let sid = session(&setup);
    let admission = gate
        .admit_ordinary_launch(&sid, AdmissionBounds::default())
        .unwrap();
    assert_eq!(
        gate.establish_pool_transition(&selection(&gate), AdmissionBounds::default())
            .err()
            .unwrap()
            .cause()
            .code(),
        "RESERVATION_REENTRANT_ADMISSION"
    );
    assert!(!pending(&setup.tree).exists());
    admission.close().unwrap();
    let fence = gate
        .establish_pool_transition(&selection(&gate), AdmissionBounds::default())
        .unwrap();
    assert_blocked(&gate, &sid);
    drop(fence);
}

#[test]
fn changed_evidence_returns_whole_failure_and_cannot_replay_or_clear_fence() {
    crate::test_process::owning_case!(
        changed_evidence_returns_whole_failure_and_cannot_replay_or_clear_fence
    );
    let (setup, _fixture, gate) = prepared();
    let fence = gate
        .establish_pool_transition(&selection(&gate), AdmissionBounds::default())
        .unwrap();
    setup.tree.write(
        "state/resource-reservation-control.pending",
        b"changed evidence",
    );
    let failure = fence.assert_current().err().unwrap();
    assert_eq!(failure.cause().code(), "POOL_TRANSITION_PENDING_CHANGED");
    assert!(failure.retained.as_ref().unwrap().fence.is_some());
    assert_blocked(&gate, &session(&setup));
    assert_eq!(
        gate.establish_pool_transition(&selection(&gate), AdmissionBounds::default())
            .err()
            .unwrap()
            .cause()
            .code(),
        "POOL_TRANSITION_REQUIRES_RECONCILIATION"
    );
    drop(failure);
    assert_eq!(fs::read(pending(&setup.tree)).unwrap(), b"changed evidence");
}
