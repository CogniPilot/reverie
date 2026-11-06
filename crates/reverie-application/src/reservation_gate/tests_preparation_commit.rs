use super::*;
use reverie_core::ids::ProfileSessionId;
fn preparing() -> (
    Setup,
    Arc<Fixture>,
    ReservationGate,
    RetainedPreparation,
    PathBuf,
) {
    let setup = Setup::new();
    record_source_binding(&setup);
    let directory = setup.tree.root.join("actor-policy");
    fs::create_dir(&directory).unwrap();
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
    setup
        .tree
        .write("actor-policy/worker.json", &setup.tree.raw);
    let path = directory.join("worker.json");
    let fixture = Fixture::new();
    fixture.storage_facts(setup.stats);
    fill(&fixture, &setup);
    retain_tail(&fixture, &setup);
    let gate = ReservationGate::new(load_owner_config(&path).unwrap(), fixture.observer()).unwrap();
    let draft = gate
        .draft_approved_profile(&employee(&setup), &key())
        .unwrap();
    let mut claim = gate
        .retain_draft(&draft.draft_id(), &draft.digest())
        .unwrap();
    claim.begin_prepare().unwrap();
    let receipt: Value = serde_json::from_slice(
        &fs::read(setup.tree.root.join(format!(
            "control/operations/publication-{}.json",
            claim.operation_id().as_str()
        )))
        .unwrap(),
    )
    .unwrap();
    setup.tree.write(
        "company.json",
        &serde_json::to_vec(&json!({"employees":[receipt["afterEmployee"]]})).unwrap(),
    );
    claim.confirm_publication().unwrap();
    (setup, fixture, gate, claim, path)
}
#[test]
fn actual_policy_cas_installs_same_broker_state_and_acks_prepared_without_start_or_capacity_release()
 {
    crate::test_process::owning_case!(actual_policy_cas_installs_same_broker_state_and_acks_prepared_without_start_or_capacity_release);
    let (setup, fixture, gate, mut claim, path) = preparing();
    let old = claim.profile().binding().current_session().clone();
    let nil = ProfileSessionId::parse("00000000-0000-0000-0000-000000000000").unwrap();
    gate.inner.installed.model_laptop(old.clone());
    gate.inner.installed.model_laptop(nil.clone());
    fixture.laptop_inspection(&json!([setup.rows[1]]).to_string(), true);
    fixture.laptop_inspection(r#"[{"State":{"Running":false}}]"#, true);
    let before = fs::read(&path).unwrap();
    let profiles = fs::read(setup.tree.root.join("control/profiles/profiles.json")).unwrap();
    let record = claim.commit_configuration().unwrap();
    assert_eq!(claim.operation().state(), OperationState::Prepared);
    assert_eq!(claim.operation().record().data().version.get(), 3);
    assert!(worker_config::equivalent(
        gate.inner.config().unwrap().configuration(),
        load_owner_config(&path).unwrap().configuration()
    ));
    assert!(!worker_config::equivalent(
        gate.inner.config().unwrap().configuration(),
        claim.source_configuration()
    ));
    let ops = setup.tree.root.join("control/operations");
    assert_eq!(
        fs::read(ops.join(format!(
            "config-before-{}.json",
            claim.operation_id().as_str()
        )))
        .unwrap(),
        before
    );
    assert_eq!(
        fs::read(ops.join(format!("prepared-{}.json", claim.operation_id().as_str()))).unwrap(),
        record.canonical_bytes()
    );
    assert_eq!(
        claim
            .operation()
            .record()
            .data()
            .last_receipt_digest
            .as_ref(),
        Some(record.digest())
    );
    assert_eq!(
        fs::read(setup.tree.root.join("control/profiles/profiles.json")).unwrap(),
        profiles
    );
    assert_eq!(
        claim.commit_configuration().err().unwrap().code(),
        "RESOURCE_PREPARATION_CONFIG_ALREADY_ATTEMPTED"
    );
    let laptop_events = fixture
        .events()
        .into_iter()
        .filter(|event| event.starts_with("laptop:"))
        .collect::<Vec<_>>();
    assert_eq!(
        laptop_events,
        vec![
            format!("laptop:test-agent-{}", old.as_str()),
            format!("laptop:test-agent-{}", nil.as_str())
        ]
    );
    assert!(gate.inner.state.lock().unwrap().active.is_none());
    claim.close().unwrap();
    let cold = gate.inspect(&key()).unwrap().unwrap();
    assert!(cold.reservation_retained());
    assert!(!cold.retry_allowed());
}
#[test]
fn same_bytes_original_rebind_retains_preparing_claim_temp_and_before_evidence_without_retry() {
    crate::test_process::owning_case!(
        same_bytes_original_rebind_retains_preparing_claim_temp_and_before_evidence_without_retry
    );
    let (setup, fixture, gate, mut claim, path) = preparing();
    let policy = path.clone();
    let directory = path.parent().unwrap().to_owned();
    let original = fs::read(&path).unwrap();
    let saved = original.clone();
    let mut changed = false;
    fixture.on_query(move || {
        let has_temp = fs::read_dir(&directory).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .as_encoded_bytes()
                .starts_with(b".resource-preparing-")
        });
        if has_temp && !changed {
            changed = true;
            fs::rename(&policy, directory.join("owned-original-evidence")).unwrap();
            fs::write(&policy, &saved).unwrap();
            fs::set_permissions(&policy, fs::Permissions::from_mode(0o600)).unwrap();
        }
        Ok(())
    });
    assert_eq!(
        claim.commit_configuration().err().unwrap().code(),
        "RESOURCE_PREPARATION_CONFIG_UNCERTAIN_KEEP_ALL_EVIDENCE"
    );
    assert_eq!(claim.operation().state(), OperationState::Preparing);
    assert_eq!(fs::read(&path).unwrap(), original);
    assert!(worker_config::equivalent(
        gate.inner.config().unwrap().configuration(),
        claim.source_configuration()
    ));
    assert!(
        path.parent()
            .unwrap()
            .join("owned-original-evidence")
            .is_file()
    );
    assert!(fs::read_dir(path.parent().unwrap()).unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .as_encoded_bytes()
            .starts_with(b".resource-preparing-")
    }));
    let operations = setup.tree.root.join("control/operations");
    assert!(
        operations
            .join(format!(
                "config-attempt-{}.json",
                claim.operation_id().as_str()
            ))
            .is_file()
    );
    assert!(
        !operations
            .join(format!("prepared-{}.json", claim.operation_id().as_str()))
            .exists()
    );
    let events = fixture.events();
    assert_eq!(
        claim.commit_configuration().err().unwrap().code(),
        "RESOURCE_PREPARATION_ACTIVE_HANDLE_REQUIRED"
    );
    assert_eq!(fixture.events(), events);
}
#[test]
fn failed_optional_laptop_inspect_wins_before_json_and_keeps_actual_published_file_without_reload()
{
    crate::test_process::owning_case!(failed_optional_laptop_inspect_wins_before_json_and_keeps_actual_published_file_without_reload);
    let (setup, fixture, gate, mut claim, path) = preparing();
    let old = claim.profile().binding().current_session().clone();
    let other = ProfileSessionId::parse("00000000-0000-0000-0000-000000000000").unwrap();
    gate.inner.installed.model_laptop(old.clone());
    gate.inner.installed.model_laptop(other);
    fixture.laptop_inspection("{", false);
    let before = fs::read(&path).unwrap();
    let error = claim.commit_configuration().err().unwrap();
    let GateError::PreparationConfigUncertain { cause } = error else {
        panic!("failed actual reloader must retain uncertainty")
    };
    assert_eq!(cause.code(), "WORKER_RESOURCE_RELOAD_LAPTOP_UNAVAILABLE");
    assert_ne!(
        fs::read(&path).unwrap(),
        before,
        "renamed candidate is never restored after later failure"
    );
    assert!(worker_config::equivalent(
        gate.inner.config().unwrap().configuration(),
        claim.source_configuration()
    ));
    assert_eq!(claim.operation().state(), OperationState::Preparing);
    assert_eq!(
        fixture
            .events()
            .iter()
            .filter(|event| event.starts_with("laptop:"))
            .count(),
        1,
        "later registered laptop is not queried after first refusal"
    );
    assert!(
        !setup
            .tree
            .root
            .join(format!(
                "control/operations/prepared-{}.json",
                claim.operation_id().as_str()
            ))
            .exists()
    );
    assert_eq!(
        claim.commit_configuration().err().unwrap().code(),
        "RESOURCE_PREPARATION_ACTIVE_HANDLE_REQUIRED"
    );
}
#[test]
fn ordinary_reload_reads_real_file_and_cannot_install_changed_projections_for_active_claim() {
    crate::test_process::owning_case!(
        ordinary_reload_reads_real_file_and_cannot_install_changed_projections_for_active_claim
    );
    let (_setup, fixture, _gate, claim, path) = preparing();
    let broker =
        ReservationGate::new(load_owner_config(&path).unwrap(), fixture.observer()).unwrap();
    broker.reload_owner_configuration().unwrap();
    let before = broker.installed_snapshot().unwrap();
    let staged = claim.stage_configuration().unwrap();
    let bytes =
        reverie_contracts::reservation_policy::PolicyCandidateData::capture(staged.configuration())
            .unwrap();
    fs::write(&path, bytes.bytes()).unwrap();
    assert_eq!(
        broker.reload_owner_configuration().unwrap_err().code(),
        "RESOURCE_RESERVATION_REQUIRES_PROTECTED_RECONCILIATION"
    );
    assert!(
        Arc::ptr_eq(&before, &broker.installed_snapshot().unwrap()),
        "failed file reload never swaps the installed snapshot"
    );
    assert_eq!(claim.operation().state(), OperationState::Preparing);
    claim.close().unwrap();
}
