use super::*;
use reverie_core::operations::OperationState;
fn retained(setup: &Setup, fixture: &Arc<Fixture>) -> (ReservationGate, RetainedPreparation) {
    let gate = setup.gate(fixture);
    fill(fixture, setup);
    retain_tail(fixture, setup);
    let preview = gate
        .draft_approved_profile(&employee(setup), &key())
        .unwrap();
    let claim = gate
        .retain_draft(&preview.draft_id(), &preview.digest())
        .unwrap();
    (gate, claim)
}
fn record_source_binding(setup: &Setup) {
    let sid = setup.oracle["employee"]["sessionId"].as_str().unwrap();
    let directory = setup.tree.root.join("state").join(sid);
    fs::create_dir(&directory).unwrap();
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
    setup.tree.write(&format!("state/{sid}/storage-owner.json"),&serde_json::to_vec(&json!({"version":1,"employeeId":setup.employee().as_str(),"sessionId":sid,"owner":setup.oracle["employee"]["owner"]})).unwrap());
}
#[test]
fn actual_preparing_is_durable_once_before_normal_rebind_and_readonly_publication_ack() {
    let setup = Setup::new();
    record_source_binding(&setup);
    let mut before = setup.oracle["employee"].clone();
    before["runtimeRecipe"] = json!({"mode":"codex","configs":{"codexConfig":{"model":"owned-fixture","resumeSessionId":"old-thread","unknown":"keep"}},"runtimeThreads":{"old":"old-thread"}});
    setup.tree.write(
        "company.json",
        &serde_json::to_vec(&json!({"employees":[before]})).unwrap(),
    );
    let original = fs::read(setup.tree.root.join("company.json")).unwrap();
    let profile = fs::read(setup.tree.root.join("control/profiles/profiles.json")).unwrap();
    let fixture = Fixture::new();
    let (gate, mut claim) = retained(&setup, &fixture);
    let facts = claim.begin_prepare().unwrap();
    assert_eq!(claim.operation().state(), OperationState::Preparing);
    assert_eq!(claim.operation().record().data().version.get(), 2);
    let path = setup.tree.root.join(format!(
        "control/operations/publication-{}.json",
        claim.operation_id().as_str()
    ));
    let raw = fs::read(&path).unwrap();
    let receipt: Value = serde_json::from_slice(&raw).unwrap();
    assert_eq!(sha(&raw), facts.digest.as_str());
    assert_eq!(receipt["beforeEmployee"], before);
    assert_eq!(receipt["afterEmployee"]["sessionId"], facts.target.as_str());
    assert_eq!(receipt["afterEmployee"]["sessionGeneration"], 2);
    assert_eq!(
        receipt["afterEmployee"]["runtimeRecipe"]["runtimeThreads"],
        json!({})
    );
    assert!(
        receipt["afterEmployee"]["runtimeRecipe"]["configs"]["codexConfig"]
            .get("resumeSessionId")
            .is_none()
    );
    assert_eq!(
        receipt["afterEmployee"]["runtimeRecipe"]["configs"]["codexConfig"]["unknown"],
        "keep"
    );
    assert_eq!(
        fs::read(setup.tree.root.join("company.json")).unwrap(),
        original,
        "PREPARING does not write the company binding"
    );
    let events = fixture.events();
    assert_eq!(
        claim.begin_prepare().err().unwrap().code(),
        "RESOURCE_PREPARATION_ALREADY_ATTEMPTED"
    );
    assert_eq!(fixture.events(), events);
    assert_eq!(fs::read(&path).unwrap(), raw);
    setup.tree.write(
        "company.json",
        &serde_json::to_vec(&json!({"employees":[receipt["afterEmployee"]]})).unwrap(),
    );
    claim.confirm_publication().unwrap();
    assert_eq!(
        claim.operation().state(),
        OperationState::Preparing,
        "metadata acknowledgement does not acknowledge prepared/readiness/start"
    );
    assert_eq!(
        fs::read(setup.tree.root.join("control/profiles/profiles.json")).unwrap(),
        profile
    );
    claim.close().unwrap();
    let cold = gate.inspect(&key()).unwrap().unwrap();
    assert!(cold.reservation_retained());
    assert!(!cold.retry_allowed());
    assert_eq!(cold.record().data().state, OperationState::Preparing);
}
#[test]
fn premature_publication_and_post_preparing_native_loss_close_owner_keep_claim_and_forbid_retry() {
    let setup = Setup::new();
    let fixture = Fixture::new();
    let (_gate, mut claim) = retained(&setup, &fixture);
    claim.begin_prepare().unwrap();
    let journal = setup.tree.root.join("control/operations/operations.json");
    let before = fs::read(&journal).unwrap();
    let error = claim.confirm_publication().unwrap_err();
    let GateError::PreparationPublicationUncertain { cause } = error else {
        panic!("missing real rebind cannot acknowledge publication")
    };
    assert_eq!(cause.code(), "RESOURCE_PREPARATION_PUBLICATION_CHANGED");
    assert_eq!(
        claim.begin_prepare().err().unwrap().code(),
        "RESOURCE_PREPARATION_ACTIVE_HANDLE_REQUIRED"
    );
    assert_eq!(fs::read(&journal).unwrap(), before);
    claim.close().unwrap();
    let setup = Setup::new();
    let fixture = Fixture::new();
    let (_gate, mut claim) = retained(&setup, &fixture);
    let journal = setup.tree.root.join("control/operations/operations.json");
    let observed = journal.clone();
    fixture.on_query(move || {
        let doc = operations_v1::decode(&fs::read(&observed).unwrap()).unwrap();
        if doc
            .operations()
            .values()
            .any(|op| op.data().state == OperationState::Preparing)
        {
            Err(ObserverError::Refused("OWNED_LOST_PREPARING_ACK"))
        } else {
            Ok(())
        }
    });
    assert_eq!(
        claim.begin_prepare().err().unwrap().code(),
        "RESOURCE_PREPARATION_INTENT_UNCERTAIN_KEEP_CLAIM"
    );
    assert_eq!(
        operations_v1::decode(&fs::read(journal).unwrap())
            .unwrap()
            .operations()
            .values()
            .next()
            .unwrap()
            .data()
            .state,
        OperationState::Preparing
    );
    assert_eq!(
        claim.begin_prepare().err().unwrap().code(),
        "RESOURCE_PREPARATION_ACTIVE_HANDLE_REQUIRED"
    );
}
#[test]
fn fresh_terminal_reader_closes_before_last_native_and_late_journal_stamp_cannot_ack_intent() {
    let setup = Setup::new();
    let fixture = Fixture::new();
    let (_gate, mut claim) = retained(&setup, &fixture);
    let directory = setup.tree.root.join("control/operations");
    let phase = directory.join(format!(
        "publication-{}.json",
        claim.operation_id().as_str()
    ));
    let seen = Arc::new(Mutex::new((false, false)));
    let witness = seen.clone();
    fixture.on_query(move || {
        if phase.exists() {
            let held = fs::read_dir("/proc/self/fd")
                .unwrap()
                .filter_map(|entry| fs::read_link(entry.unwrap().path()).ok())
                .any(|path| path == directory.join("operations.lock"));
            let mut flags = witness.lock().unwrap();
            if held {
                flags.0 = true;
            }
            if flags.0 && !held && !flags.1 {
                flags.1 = true;
                let path = directory.join("operations.json");
                let mut raw = fs::read(&path).unwrap();
                raw.push(b' ');
                fs::write(path, raw).unwrap();
            }
        }
        Ok(())
    });
    let error = claim.begin_prepare().err().unwrap();
    let GateError::PreparationIntentUncertain { cause } = error else {
        panic!("stamp loss cannot acknowledge intent")
    };
    assert!(seen.lock().unwrap().1);
    assert_eq!(cause.code(), "RESOURCE_PREPARATION_CLAIM_CHANGED");
    assert_eq!(
        claim.begin_prepare().err().unwrap().code(),
        "RESOURCE_PREPARATION_ACTIVE_HANDLE_REQUIRED"
    );
}
#[test]
fn adjacent_raw_surrogate_codepoints_are_not_normalized_by_copying_the_publication_receipt() {
    let setup = Setup::new();
    let mut row = setup.oracle["employee"].clone();
    row["runtimeRecipe"] = json!({"mode":"claude","unknown":"RAWPAIR"});
    let mut raw = serde_json::to_vec(&json!({"employees":[row]})).unwrap();
    let needle = b"RAWPAIR";
    let offset = raw
        .windows(needle.len())
        .position(|value| value == needle)
        .unwrap();
    raw.splice(
        offset..offset + needle.len(),
        [0xed, 0xa0, 0x80, 0xed, 0xb0, 0x80],
    );
    setup.tree.write("company.json", &raw);
    let fixture = Fixture::new();
    let (_gate, mut claim) = retained(&setup, &fixture);
    let error = claim.begin_prepare().err().unwrap();
    let GateError::PreparationIntentUncertain { cause } = error else {
        panic!("legacy receipt reload merges escaped pair; lossless original must refuse")
    };
    assert_eq!(cause.code(), "RESOURCE_PREPARATION_PHASE_CHANGED");
    assert_eq!(
        claim.operation().record().data().state,
        OperationState::Preparing
    );
    assert_eq!(
        claim.begin_prepare().err().unwrap().code(),
        "RESOURCE_PREPARATION_ACTIVE_HANDLE_REQUIRED"
    );
}
#[test]
fn exclusive_publication_refuses_a_retained_name_without_rollback_or_handle_retry() {
    let setup = Setup::new();
    let fixture = Fixture::new();
    let (_gate, mut claim) = retained(&setup, &fixture);
    let name = format!(
        "control/operations/publication-{}.json",
        claim.operation_id().as_str()
    );
    setup.tree.write(&name, b"{\"ownedStaleReceipt\":true}");
    assert_eq!(
        claim.begin_prepare().err().unwrap().code(),
        "RESOURCE_PREPARATION_INTENT_UNCERTAIN_KEEP_CLAIM"
    );
    assert_eq!(
        fs::read(setup.tree.root.join(name)).unwrap(),
        b"{\"ownedStaleReceipt\":true}"
    );
    assert_eq!(
        operations_v1::decode(
            &fs::read(setup.tree.root.join("control/operations/operations.json")).unwrap()
        )
        .unwrap()
        .operations()
        .values()
        .next()
        .unwrap()
        .data()
        .state,
        OperationState::Preparing
    );
    assert_eq!(
        claim.begin_prepare().err().unwrap().code(),
        "RESOURCE_PREPARATION_ACTIVE_HANDLE_REQUIRED"
    );
}
#[test]
fn twenty_two_actual_legacy_recipe_cases_keep_normal_selector_and_unknown_data_semantics() {
    let cases: Value = serde_json::from_str(include_str!(
        "../../../reverie-contracts/tests/fixtures/reservation-publication-recipes-python.json"
    ))
    .unwrap();
    for case in cases.as_array().unwrap() {
        let setup = Setup::new();
        let mut row = setup.oracle["employee"].clone();
        row["runtimeRecipe"] = case["recipe"].clone();
        setup.tree.write(
            "company.json",
            &serde_json::to_vec(&json!({"employees":[row]})).unwrap(),
        );
        let fixture = Fixture::new();
        let (_gate, mut claim) = retained(&setup, &fixture);
        let result = claim.begin_prepare();
        assert_eq!(
            result.is_ok(),
            case["accepted"].as_bool().unwrap(),
            "case {}",
            case["name"]
        );
        assert_eq!(
            claim.operation().record().data().state.name(),
            case["state"].as_str().unwrap()
        );
        assert_eq!(
            claim.operation().record().data().version.get(),
            case["version"].as_u64().unwrap()
        );
        if result.is_ok() {
            let path = setup.tree.root.join(format!(
                "control/operations/publication-{}.json",
                claim.operation_id().as_str()
            ));
            let receipt: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
            assert_eq!(
                receipt["afterEmployee"]["runtimeRecipe"], case["after"],
                "case {}",
                case["name"]
            );
        } else {
            assert_eq!(
                result.err().unwrap().code(),
                "RESOURCE_PREPARATION_INTENT_UNCERTAIN_KEEP_CLAIM"
            );
        }
        claim.close().unwrap();
    }
}
