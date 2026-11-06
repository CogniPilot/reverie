use super::*;
use reverie_contracts::reservation_baseline::OriginalRuntimeTail;
#[path = "tests_preparation_phase.rs"]
mod phase_cases;
fn fill(fixture: &Fixture, setup: &Setup) {
    for _ in 0..500 {
        fixture.inventory(&setup.rows);
    }
}
fn retain_tail(fixture: &Fixture, setup: &Setup) {
    let info = fs::symlink_metadata(&setup.tree.root).unwrap();
    fixture.original_runtime(OriginalRuntimeTail::from_observed_data(
        [info.dev(), info.ino()],
        vec![],
    ));
}
fn employee(setup: &Setup) -> JournalId {
    JournalId::parse(setup.employee().as_str()).unwrap()
}
#[test]
fn approved_preview_persists_exact_data_without_claim_and_retains_real_original_baseline() {
    let setup = Setup::new();
    let fixture = Fixture::new();
    let gate = setup.gate(&fixture);
    fill(&fixture, &setup);
    retain_tail(&fixture, &setup);
    let journal = setup.tree.root.join("control/operations/operations.json");
    let before = fs::read(&journal).unwrap();
    let profiles = fs::read(setup.tree.root.join("control/profiles/profiles.json")).unwrap();
    let company = fs::read(setup.tree.root.join("company.json")).unwrap();
    let preview = gate
        .draft_approved_profile(&employee(&setup), &key())
        .unwrap();
    assert!(!preview.capacity_held());
    assert!(!preview.native_effects());
    assert_eq!(preview.source_memory_mib(), 512);
    let path = setup.tree.root.join(format!(
        "control/operations/draft-{}.json",
        preview.draft_id().as_str()
    ));
    let record: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(fs::metadata(&path).unwrap().mode() & 0o7777, 0o600);
    assert_eq!(record["draftId"], preview.draft_id().as_str());
    assert_eq!(
        record["observation"],
        serde_json::from_str::<Value>(&setup.expected()).unwrap()
    );
    assert_eq!(sha(&fs::read(&path).unwrap()), preview.digest().as_str());
    assert_eq!(fs::read(&journal).unwrap(), before);
    assert_eq!(
        fs::read(setup.tree.root.join("control/profiles/profiles.json")).unwrap(),
        profiles
    );
    assert_eq!(
        fs::read(setup.tree.root.join("company.json")).unwrap(),
        company
    );
    let retained = gate
        .retain_draft(&preview.draft_id(), &preview.digest())
        .unwrap();
    assert_eq!(retained.operation_id(), &preview.operation_id());
    assert_eq!(
        retained.operation().record().data().reservation_id,
        preview.reservation_id()
    );
    assert_eq!(
        retained.operation().record().data().reserved_sid,
        preview.target_session()
    );
    assert_eq!(
        retained.operation().record().data().request.preview_digest,
        preview.digest()
    );
    let baseline: Value =
        serde_json::from_slice(&retained.original_baseline().canonical_bytes().unwrap()).unwrap();
    assert_eq!(baseline["schema"], "reverie-resource-native-baseline-v1");
    assert_eq!(baseline["sourceRow"], setup.rows[1]);
    assert_eq!(baseline["accounts"], json!([]));
    assert_eq!(baseline["total"], 536870912);
    assert_eq!(baseline["storage"]["/home/agent"], json!(setup.stats[0]));
    assert_eq!(
        retained.source_paths().identity(),
        setup.employee().as_str()
    );
    assert_eq!(retained.profile(), preview.profile());
    assert_eq!(retained.scope(), &gate.inner.scope);
    assert_eq!(
        worker_config::encode_config(retained.source_configuration()),
        worker_config::encode_config(gate.inner.config().unwrap().configuration())
    );
    let replay = gate
        .retain_draft(&preview.draft_id(), &preview.digest())
        .err()
        .unwrap();
    assert_eq!(replay.code(), "CLAIM_OR_RESPONSE_UNCERTAIN_KEEP_ALL_CLAIMS");
    retained.close().unwrap();
    let cold = gate.inspect(&key()).unwrap().unwrap();
    assert!(cold.reservation_retained());
    assert!(!cold.retry_allowed());
    assert_eq!(
        cold.state(),
        reverie_core::operations::OperationState::RecoveryRequired
    );
}
#[test]
fn changed_preview_refuses_before_claim_and_native_baseline_loss_retains_the_real_claim() {
    let setup = Setup::new();
    let fixture = Fixture::new();
    let gate = setup.gate(&fixture);
    fill(&fixture, &setup);
    let preview = gate
        .draft_approved_profile(&employee(&setup), &key())
        .unwrap();
    let journal = setup.tree.root.join("control/operations/operations.json");
    let before = fs::read(&journal).unwrap();
    let wrong = reverie_core::operations::JournalDigest::parse(&"a".repeat(64)).unwrap();
    assert_eq!(
        gate.retain_draft(&preview.draft_id(), &wrong)
            .err()
            .unwrap()
            .code(),
        "RESOURCE_PREPARATION_DRAFT_CHANGED"
    );
    assert_eq!(fs::read(&journal).unwrap(), before);
    let error = gate
        .retain_draft(&preview.draft_id(), &preview.digest())
        .err()
        .unwrap();
    let GateError::ClaimUncertain { cause } = error else {
        panic!("actual durable claim remains fenced")
    };
    assert_eq!(cause.code(), "FIXTURE_ORIGINAL_RUNTIME_UNAVAILABLE");
    let document = operations_v1::decode(&fs::read(&journal).unwrap()).unwrap();
    assert_eq!(document.operations().len(), 1);
    assert!(gate.inner.state.lock().unwrap().active.is_none());
    let directory = setup.tree.root.join("control/operations");
    assert!(
        !fs::read_dir("/proc/self/fd")
            .unwrap()
            .filter_map(|entry| fs::read_link(entry.unwrap().path()).ok())
            .any(|path| path == directory),
        "failed retained construction closes the owned store"
    );
}
#[test]
fn preview_closes_original_reader_before_publishing_and_terminal_native_checks() {
    use std::sync::atomic::{AtomicBool, Ordering};
    let setup = Setup::new();
    let fixture = Fixture::new();
    let gate = setup.gate(&fixture);
    fill(&fixture, &setup);
    let directory = setup.tree.root.join("control/operations");
    let seen = Arc::new(AtomicBool::new(false));
    let witness = seen.clone();
    fixture.on_query(move || {
        let published = fs::read_dir(&directory).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .as_encoded_bytes()
                .starts_with(b"draft-")
        });
        if published {
            witness.store(true, Ordering::SeqCst);
            assert!(
                !fs::read_dir("/proc/self/fd")
                    .unwrap()
                    .filter_map(|entry| fs::read_link(entry.unwrap().path()).ok())
                    .any(|path| path == directory || path == directory.join("operations.lock")),
                "draft store and exact terminal reader close before terminal native observations"
            );
        }
        Ok(())
    });
    gate.draft_approved_profile(&employee(&setup), &key())
        .unwrap();
    assert!(seen.load(Ordering::SeqCst));
}
#[test]
fn legacy_nil_source_session_is_preview_data_but_cannot_produce_a_retained_claim() {
    let mut setup = Setup::new();
    let nil = "00000000-0000-0000-0000-000000000000";
    setup.oracle["employee"]["sessionId"] = json!(nil);
    setup.oracle["profile"]["binding"]["current_sid"] = json!(nil);
    setup.tree.write(
        "company.json",
        &serde_json::to_vec(&json!({"employees":[setup.oracle["employee"]],"retired":[]})).unwrap(),
    );
    let eid = setup.employee();
    let mut profiles = serde_json::Map::new();
    profiles.insert(eid.as_str().to_owned(), setup.oracle["profile"].clone());
    setup.tree.write("control/profiles/profiles.json",&serde_json::to_vec(&json!({"schema":"reverie-employee-resource-profiles-v1","revision":1,"profiles":profiles})).unwrap());
    setup.rows[1]["Config"]["Labels"]["reverie.session"] = json!(nil);
    setup.rows[1]["Name"] = json!(format!("/test-agent-{nil}"));
    let fixture = Fixture::new();
    let gate = setup.gate(&fixture);
    fill(&fixture, &setup);
    retain_tail(&fixture, &setup);
    let before = fs::read(setup.tree.root.join("control/operations/operations.json")).unwrap();
    let preview = gate
        .draft_approved_profile(&employee(&setup), &key())
        .unwrap();
    let path = setup.tree.root.join(format!(
        "control/operations/draft-{}.json",
        preview.draft_id().as_str()
    ));
    let record: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    assert_eq!(record["observation"]["current_sid"], nil);
    assert!(
        gate.retain_draft(&preview.draft_id(), &preview.digest())
            .is_err()
    );
    assert_eq!(
        fs::read(setup.tree.root.join("control/operations/operations.json")).unwrap(),
        before
    );
    assert!(
        !fixture
            .events()
            .iter()
            .any(|event| event == "original-runtime"),
        "invalid journal roles fail before any retained baseline producer"
    );
}
#[test]
fn python_equal_profile_numbers_preserve_request_validation_and_native_read_priority() {
    for (field, expected) in [
        ("version", "UINT64"),
        ("memoryMiB", "RESERVATION_REQUEST_PROFILE"),
    ] {
        let setup = Setup::new();
        let fixture = Fixture::new();
        let gate = setup.gate(&fixture);
        fill(&fixture, &setup);
        let preview = gate
            .draft_approved_profile(&employee(&setup), &key())
            .unwrap();
        let path = setup.tree.root.join(format!(
            "control/operations/draft-{}.json",
            preview.draft_id().as_str()
        ));
        let mut record: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        if field == "version" {
            record["profile"][field] = json!(1.0);
        } else {
            record["profile"]["resources"][field] = json!(1024.0);
        }
        let raw = serde_json::to_vec(&record).unwrap();
        fs::write(path, &raw).unwrap();
        let digest = reverie_core::operations::JournalDigest::parse(&sha(&raw)).unwrap();
        let before = fixture.events().len();
        let error = gate
            .retain_draft(&preview.draft_id(), &digest)
            .err()
            .unwrap();
        assert_eq!(error.code(), expected);
        assert!(
            fixture.events().len() > before,
            "original admission/native reads precede malformed request fields"
        );
        assert!(
            operations_v1::decode(
                &fs::read(setup.tree.root.join("control/operations/operations.json")).unwrap()
            )
            .unwrap()
            .operations()
            .is_empty()
        );
        fixture.on_query(|| Err(ObserverError::Refused("OWNED_EARLIER_NATIVE_FAILURE")));
        assert_eq!(
            gate.retain_draft(&preview.draft_id(), &digest)
                .err()
                .unwrap()
                .code(),
            "OWNED_EARLIER_NATIVE_FAILURE"
        );
    }
}
#[test]
fn stored_target_mismatch_refuses_before_any_live_profile_read_or_native_observation() {
    let setup = Setup::new();
    let fixture = Fixture::new();
    let gate = setup.gate(&fixture);
    fill(&fixture, &setup);
    let preview = gate
        .draft_approved_profile(&employee(&setup), &key())
        .unwrap();
    let path = setup.tree.root.join(format!(
        "control/operations/draft-{}.json",
        preview.draft_id().as_str()
    ));
    let mut record: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    record["profile"]["binding"]["target_sid"] = json!(key().as_str());
    let raw = serde_json::to_vec(&record).unwrap();
    fs::write(path, &raw).unwrap();
    let digest = reverie_core::operations::JournalDigest::parse(&sha(&raw)).unwrap();
    fs::remove_file(setup.tree.root.join("control/profiles/profiles.json")).unwrap();
    let events = fixture.events();
    assert_eq!(
        gate.retain_draft(&preview.draft_id(), &digest)
            .err()
            .unwrap()
            .code(),
        "RESOURCE_PREPARATION_DRAFT_CHANGED"
    );
    assert_eq!(fixture.events(), events);
}
#[test]
fn draft_profile_comparison_keeps_legacy_python_numeric_equality_without_minting_a_profile() {
    for cpus in [json!(false), json!(-0.0)] {
        let setup = Setup::new();
        let fixture = Fixture::new();
        let gate = setup.gate(&fixture);
        fill(&fixture, &setup);
        retain_tail(&fixture, &setup);
        let preview = gate
            .draft_approved_profile(&employee(&setup), &key())
            .unwrap();
        let path = setup.tree.root.join(format!(
            "control/operations/draft-{}.json",
            preview.draft_id().as_str()
        ));
        let mut record: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        record["profile"]["resources"]["cpus"] = cpus;
        let raw = serde_json::to_vec(&record).unwrap();
        fs::write(path, &raw).unwrap();
        let digest = reverie_core::operations::JournalDigest::parse(&sha(&raw)).unwrap();
        let retained = gate.retain_draft(&preview.draft_id(), &digest).unwrap();
        assert_eq!(
            retained.profile(),
            preview.profile(),
            "the real canonical profile is retained; draft equality does not construct an invalid bool-CPU policy"
        );
        assert_eq!(
            retained.operation().record().data().request.preview_digest,
            digest
        );
        retained.close().unwrap();
    }
}
