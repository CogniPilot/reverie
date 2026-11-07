use super::*;
use crate::reservation_gate::GateError;

fn prepared() -> (Setup, Arc<Fixture>, ReservationGate, RetainedPreparation) {
    let (setup, fixture, gate, mut claim, _) = preparing();
    claim.commit_configuration().unwrap();
    fixture.native_start_facts();
    (setup, fixture, gate, claim)
}
fn receipt_path(setup: &Setup, claim: &RetainedPreparation, prefix: &str) -> PathBuf {
    setup.tree.root.join(format!(
        "control/operations/{prefix}-{}.json",
        claim.operation_id().as_str()
    ))
}
fn uncertain(error: GateError) -> GateError {
    match error {
        GateError::NativeStartIntentUncertain { cause } => *cause,
        error => panic!("expected retained start uncertainty, got {error:?}"),
    }
}
fn replace_phase_after_intent(fixture: &Fixture, phase: PathBuf, check: PathBuf) {
    let mut replaced = false;
    fixture.on_query(move || {
        if !check.exists() || replaced {
            return Ok(());
        }
        replaced = true;
        let raw = fs::read(&phase).unwrap();
        fs::rename(&phase, phase.with_extension("preserved")).unwrap();
        fs::write(&phase, raw).unwrap();
        fs::set_permissions(&phase, fs::Permissions::from_mode(0o600)).unwrap();
        Ok(())
    });
}
#[test]
fn real_start_intent_commits_starting_once_and_leaves_claim_after_checked_close() {
    crate::test_process::owning_case!(
        real_start_intent_commits_starting_once_and_leaves_claim_after_checked_close
    );
    let (setup, fixture, gate, mut claim) = prepared();
    let profiles = fs::read(setup.tree.root.join("control/profiles/profiles.json")).unwrap();
    let intent = claim.begin_native_start().unwrap();
    assert_eq!(intent.operation_id(), claim.operation_id());
    assert_eq!(
        intent.target_session(),
        claim.profile().binding().target_session()
    );
    assert_eq!(
        (
            claim.operation().state(),
            claim.operation().record().data().version.get()
        ),
        (OperationState::Starting, 4)
    );
    let receipt: Value =
        serde_json::from_slice(&fs::read(receipt_path(&setup, &claim, "start-attempt")).unwrap())
            .unwrap();
    assert_eq!(receipt["schema"], "reverie-resource-start-intent-v1");
    assert_eq!(receipt["operationId"], intent.operation_id().as_str());
    assert_eq!(receipt["state"], "STARTING");
    assert_eq!(receipt.as_object().unwrap().len(), 6);
    assert_eq!(
        claim.begin_native_start().err().unwrap().code(),
        "RESOURCE_NATIVE_START_ALREADY_ATTEMPTED"
    );
    assert_eq!(
        claim.inspect_native_start(&intent).err().unwrap().code(),
        "RESOURCE_NATIVE_OLD_LAPTOP_RUNNING"
    );
    assert!(gate.inner.state.lock().unwrap().active.is_none());
    assert_eq!(
        fs::read(setup.tree.root.join("control/profiles/profiles.json")).unwrap(),
        profiles
    );
    assert!(
        fixture
            .events()
            .iter()
            .any(|event| event == "start-accounts")
    );
    let opid = claim.operation_id().clone();
    claim.close().unwrap();
    let document = operations_v1::decode(
        &fs::read(setup.tree.root.join("control/operations/operations.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        document.operations()[&opid].data().state,
        OperationState::Starting
    );
}
#[test]
fn stopped_source_needs_explicit_release_and_exact_live_intent_without_releasing_own_hold() {
    crate::test_process::owning_case!(
        stopped_source_needs_explicit_release_and_exact_live_intent_without_releasing_own_hold
    );
    let (setup, fixture, gate, mut claim) = prepared();
    let intent = claim.begin_native_start().unwrap();
    let mut rows = setup.rows.clone();
    rows[1]["State"] = json!({"Running":false,"Pid":0});
    fixture.replace_inventory(&rows);
    fixture.old_release("RESOURCE_NATIVE_OLD_PROCESS_ALIVE");
    assert_eq!(
        claim.inspect_native_start(&intent).err().unwrap().code(),
        "RESOURCE_NATIVE_OLD_PROCESS_ALIVE"
    );
    fixture.old_release("released");
    let facts = claim.inspect_native_start(&intent).unwrap();
    assert_eq!(facts.state(), "SOURCE_RELEASED_TARGET_NOT_CREATED");
    assert_eq!(facts.operation_id(), claim.operation_id());
    assert_eq!(facts.target_session(), intent.target_session());
    assert_eq!(claim.operation().state(), OperationState::Starting);
    let (_other_setup, _other_fixture, _other_gate, mut other) = prepared();
    let foreign = other.begin_native_start().unwrap();
    assert_eq!(
        claim.inspect_native_start(&foreign).err().unwrap().code(),
        "RESOURCE_NATIVE_PERMIT_CHANGED"
    );
    assert!(gate.inner.state.lock().unwrap().active.is_none());
    claim.close().unwrap();
    other.close().unwrap();
}
#[test]
fn missing_prepared_receipt_cannot_commit_start_and_earlier_old_binding_fault_wins() {
    crate::test_process::owning_case!(
        missing_prepared_receipt_cannot_commit_start_and_earlier_old_binding_fault_wins
    );
    for drift in [false, true] {
        let (setup, fixture, gate, mut claim) = prepared();
        fs::remove_file(receipt_path(&setup, &claim, "prepared")).unwrap();
        if drift {
            let mut rows = setup.rows.clone();
            rows[1]["Name"] = json!("/foreign");
            fixture.replace_inventory(&rows);
        }
        let error = uncertain(claim.begin_native_start().err().unwrap());
        if drift {
            assert_eq!(error.code(), "RESOURCE_NATIVE_OLD_BINDING_CHANGED");
        } else {
            assert_eq!(error.code(), "STORAGE_IDENTITY_IO");
            let GateError::Control(reverie_host::reservation_control::ControlHostError::Metadata(
                reverie_store::storage_identity::IdentityError::Io(cause),
            )) = error
            else {
                panic!("missing prepared metadata must keep its typed I/O cause")
            };
            assert_eq!(cause.kind(), std::io::ErrorKind::NotFound);
        }
        assert_eq!(claim.operation().state(), OperationState::Prepared);
        assert!(!receipt_path(&setup, &claim, "start-attempt").exists());
        assert_eq!(
            claim.begin_native_start().err().unwrap().code(),
            "RESOURCE_PREPARATION_ACTIVE_HANDLE_REQUIRED"
        );
        assert!(gate.inner.state.lock().unwrap().active.is_none());
    }
}
#[test]
fn changed_prepared_receipt_hash_refuses_before_starting_intent() {
    crate::test_process::owning_case!(changed_prepared_receipt_hash_refuses_before_starting_intent);
    let (setup, _fixture, gate, mut claim) = prepared();
    let path = receipt_path(&setup, &claim, "prepared");
    let mut value: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    value["afterConfigDigest"] = json!("f".repeat(64));
    fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
    assert_eq!(
        uncertain(claim.begin_native_start().err().unwrap()).code(),
        "RESOURCE_NATIVE_PREPARATION_CHANGED"
    );
    assert_eq!(claim.operation().state(), OperationState::Prepared);
    assert!(!receipt_path(&setup, &claim, "start-attempt").exists());
    assert!(gate.inner.state.lock().unwrap().active.is_none());
}
#[test]
fn occupied_intent_and_post_write_phase_rebind_keep_starting_without_retry() {
    crate::test_process::owning_case!(
        occupied_intent_and_post_write_phase_rebind_keep_starting_without_retry
    );
    for occupied in [true, false] {
        let (setup, fixture, gate, mut claim) = prepared();
        let intent = receipt_path(&setup, &claim, "start-attempt");
        if occupied {
            fs::write(&intent, b"owner evidence").unwrap();
        } else {
            let phase = receipt_path(&setup, &claim, "publication");
            replace_phase_after_intent(&fixture, phase, intent.clone());
        }
        let error = uncertain(claim.begin_native_start().err().unwrap());
        if !occupied {
            assert_eq!(error.code(), "RESOURCE_NATIVE_PHASE_CHANGED");
        } else {
            assert_eq!(fs::read(&intent).unwrap(), b"owner evidence");
        }
        assert_eq!(claim.operation().state(), OperationState::Starting);
        assert!(intent.exists());
        assert_eq!(
            claim.begin_native_start().err().unwrap().code(),
            "RESOURCE_PREPARATION_ACTIVE_HANDLE_REQUIRED"
        );
        assert!(gate.inner.state.lock().unwrap().active.is_none());
    }
}
