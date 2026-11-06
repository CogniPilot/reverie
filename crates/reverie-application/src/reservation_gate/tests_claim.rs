use super::*;
use reverie_core::operations::{MemoryBytes, OperationRequest, OperationState};
fn request(setup: &Setup) -> OperationRequest {
    let observed = operations_v1::decode_observation(setup.expected().as_bytes()).unwrap();
    let data = observed.data();
    OperationRequest {
        employee_id: data.employee_id.clone(),
        pool_id: data.pool_id.clone(),
        source_binding_digest: data.source_binding_digest.clone(),
        profile_version: data.profile_version,
        requested_memory_bytes: MemoryBytes::try_new(1024 * reverie_core::operations::MIB).unwrap(),
        preview_digest: reverie_core::operations::JournalDigest::parse(&"a".repeat(64)).unwrap(),
        observation_digest: operations_v1::observation_digest(&observed),
    }
}
#[test]
fn metadata_reserve_and_replay_use_actual_flock_journal_claim_and_terminal_native_fences() {
    let setup = Setup::new();
    let fixture = Fixture::new();
    let gate = setup.gate(&fixture);
    for _ in 0..200 {
        fixture.inventory(&setup.rows);
    }
    let request = request(&setup);
    let view = gate.reserve(&key(), &request).unwrap();
    assert_eq!(view.state(), OperationState::Reserved);
    assert!(!view.verified());
    assert!(view.reservation_retained());
    let path = setup.tree.root.join("control/operations/operations.json");
    let before = fs::read(&path).unwrap();
    let document = operations_v1::decode(&before).unwrap();
    assert_eq!(document.operations().len(), 1);
    assert_eq!(
        view.record().data().reserved_sid.as_str(),
        setup.oracle["profile"]["binding"]["target_sid"]
            .as_str()
            .unwrap()
    );
    let replay = gate.reserve(&key(), &request).unwrap();
    assert_eq!(replay.record(), view.record());
    assert_eq!(fs::read(&path).unwrap(), before);
    assert!(gate.inner.state.lock().unwrap().active.is_none());
    let cold = gate.inspect(&key()).unwrap().unwrap();
    assert_eq!(
        cold.state(),
        OperationState::RecoveryRequired,
        "public metadata entry retains no effect handle"
    );
    assert!(!cold.retry_allowed());
    let recovery = gate.cold_inspect().unwrap();
    assert!(recovery.recovery_required());
    assert!(recovery.reservation_retained());
    assert!(!recovery.retry_allowed());
    assert_eq!(
        recovery.observations()[0].native,
        NativeObservationState::Matches
    );
    assert_eq!(
        recovery.fenced_sessions(),
        std::slice::from_ref(&view.record().data().reserved_sid)
    );
    let company = fs::read(setup.tree.root.join("company.json")).unwrap();
    fs::remove_file(setup.tree.root.join("company.json")).unwrap();
    let unresolved = gate.cold_inspect().unwrap();
    assert_eq!(
        unresolved.observations()[0].native,
        NativeObservationState::Unavailable
    );
    assert!(unresolved.reservation_retained());
    setup.tree.write("company.json", &company);
    let mut profiles: Value = serde_json::from_slice(
        &fs::read(setup.tree.root.join("control/profiles/profiles.json")).unwrap(),
    )
    .unwrap();
    profiles["profiles"][setup.employee().as_str()]["version"] = json!(2);
    setup.tree.write(
        "control/profiles/profiles.json",
        &serde_json::to_vec(&profiles).unwrap(),
    );
    assert_eq!(
        gate.cold_inspect().unwrap().observations()[0].native,
        NativeObservationState::Changed
    );
    assert_eq!(
        fs::read(&path).unwrap(),
        before,
        "cold inspection never edits or releases retained rows"
    );
}
#[test]
fn published_target_and_stale_preview_refuse_before_any_durable_claim() {
    let setup = Setup::new();
    let fixture = Fixture::new();
    let gate = setup.gate(&fixture);
    for _ in 0..100 {
        fixture.inventory(&setup.rows);
    }
    let path = setup.tree.root.join("control/operations/operations.json");
    let before = fs::read(&path).unwrap();
    let mut proposal = request(&setup);
    proposal.observation_digest =
        reverie_core::operations::JournalDigest::parse(&"f".repeat(64)).unwrap();
    assert_eq!(
        gate.reserve(&key(), &proposal).unwrap_err().code(),
        "STALE_CAPACITY_SNAPSHOT"
    );
    let target = setup.oracle["profile"]["binding"]["target_sid"]
        .as_str()
        .unwrap();
    fs::create_dir(setup.tree.root.join("state").join(target)).unwrap();
    assert_eq!(
        gate.reserve(&key(), &request(&setup)).unwrap_err().code(),
        "RESERVATION_TARGET_ALREADY_PUBLISHED"
    );
    assert_eq!(fs::read(path).unwrap(), before);
    assert!(gate.inner.state.lock().unwrap().active.is_none());
}

#[test]
fn native_ack_loss_after_publication_keeps_the_positive_claim_and_cold_fence() {
    let setup = Setup::new();
    let fixture = Fixture::new();
    let gate = setup.gate(&fixture);
    for _ in 0..120 {
        fixture.inventory(&setup.rows);
    }
    let path = setup.tree.root.join("control/operations/operations.json");
    let selected = path.clone();
    fixture.on_query(move || {
        let doc = operations_v1::decode(&fs::read(&selected).unwrap()).unwrap();
        if doc.operations().is_empty() {
            Ok(())
        } else {
            Err(ObserverError::Refused("OWNED_ENGINE_AFTER_PUBLICATION"))
        }
    });
    let error = gate.reserve(&key(), &request(&setup)).unwrap_err();
    assert!(matches!(error,GateError::Journal(ref cause) if cause.is_uncertain()));
    assert_eq!(
        operations_v1::decode(&fs::read(&path).unwrap())
            .unwrap()
            .operations()
            .len(),
        1
    );
    fixture.on_query(|| Ok(()));
    let cold = gate.inspect(&key()).unwrap().unwrap();
    assert_eq!(cold.state(), OperationState::RecoveryRequired);
    assert!(cold.reservation_retained());
    assert!(!cold.retry_allowed());
    assert!(gate.inner.state.lock().unwrap().active.is_none());
}

#[test]
fn terminal_reader_and_original_store_close_before_native_and_last_named_stamp() {
    use std::sync::atomic::{AtomicBool, Ordering};
    let setup = Setup::new();
    let fixture = Fixture::new();
    let gate = setup.gate(&fixture);
    for _ in 0..160 {
        fixture.inventory(&setup.rows);
    }
    let directory = setup.tree.root.join("control/operations");
    let path = directory.join("operations.json");
    let seen = Arc::new(AtomicBool::new(false));
    let witness = seen.clone();
    fixture.on_query(move || {
        let doc = operations_v1::decode(&fs::read(&path).unwrap()).unwrap();
        let held = fs::read_dir("/proc/self/fd")
            .unwrap()
            .filter_map(|entry| fs::read_link(entry.unwrap().path()).ok())
            .any(|target| target == directory || target == directory.join("operations.lock"));
        if !doc.operations().is_empty() && !held && !witness.swap(true, Ordering::SeqCst) {
            let mut raw = fs::read(&path).unwrap();
            raw.push(b' ');
            fs::write(&path, raw).unwrap();
        }
        Ok(())
    });
    let error = gate.reserve(&key(), &request(&setup)).unwrap_err();
    assert!(
        seen.load(Ordering::SeqCst),
        "both journal handles must close before terminal native query"
    );
    let GateError::ClaimUncertain { cause } = error else {
        panic!("terminal response cannot release the durable claim")
    };
    assert_eq!(cause.code(), "RESERVATION_CLAIM_CHANGED");
    assert!(gate.inner.state.lock().unwrap().active.is_none());
}
#[test]
fn cold_recovery_preserves_actual_legacy_structural_vs_unavailable_observation_failures() {
    let setup = Setup::new();
    let fixture = Fixture::new();
    let gate = setup.gate(&fixture);
    for _ in 0..1200 {
        fixture.inventory(&setup.rows);
    }
    let view = gate.reserve(&key(), &request(&setup)).unwrap();
    let journal = setup.tree.root.join("control/operations/operations.json");
    let before = fs::read(&journal).unwrap();
    let cases: Value = serde_json::from_str(include_str!(
        "../../../reverie-contracts/tests/fixtures/reservation-recovery-structure-python.json"
    ))
    .unwrap();
    for case in cases.as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let company = adapted_company(&setup, &case["company"]);
        let path = setup.tree.root.join("company.json");
        if name == "missing-file" {
            fs::remove_file(&path).unwrap();
        } else {
            setup
                .tree
                .write("company.json", &serde_json::to_vec(&company).unwrap());
        }
        let result = gate.cold_inspect();
        if case["outcome"] == "structural" {
            assert_eq!(
                result.unwrap_err().code(),
                "RESERVATION_COMPANY_STRUCTURE",
                "{name}"
            );
        } else {
            let facts = result.unwrap();
            assert_eq!(
                facts.observations()[0].native,
                NativeObservationState::Unavailable,
                "{name}"
            );
            assert!(facts.reservation_retained());
            assert!(!facts.retry_allowed());
            assert_eq!(
                facts.fenced_sessions(),
                std::slice::from_ref(&view.record().data().reserved_sid)
            );
        }
        assert_eq!(
            fs::read(&journal).unwrap(),
            before,
            "{name}: recovery never edits or releases claims"
        );
        assert!(
            gate.inner.state.lock().unwrap().active.is_none(),
            "{name}: admission cleanup remains mandatory"
        );
    }
    setup.tree.write("company.json", b"{}");
    fixture.on_query(|| Err(ObserverError::Refused("OWNED_EARLIER_NATIVE_FAILURE")));
    assert_eq!(
        gate.cold_inspect().unwrap_err().code(),
        "OWNED_EARLIER_NATIVE_FAILURE",
        "no extra early company read may replace an existing native-phase failure"
    );
}
fn adapted_company(setup: &Setup, original: &Value) -> Value {
    let mut company = original.clone();
    let Some(rows) = company.get_mut("employees").and_then(Value::as_array_mut) else {
        return company;
    };
    for row in rows {
        let Some(row) = row.as_object_mut() else {
            continue;
        };
        if !row.contains_key("id") {
            continue;
        }
        row.insert("id".into(), json!(setup.employee().as_str()));
        if row.contains_key("sessionId") {
            row.insert(
                "sessionId".into(),
                setup.oracle["employee"]["sessionId"].clone(),
            );
        }
        row.insert("owner".into(), setup.oracle["employee"]["owner"].clone());
    }
    company
}
