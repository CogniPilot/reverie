use super::*;
fn setup_gate(setup: &Setup, fixture: &Arc<Fixture>) -> ReservationGate {
    let gate = setup.gate(fixture);
    for _ in 0..700 {
        fixture.inventory(&setup.rows);
    }
    gate
}
fn eid(setup: &Setup) -> JournalId {
    JournalId::parse(setup.employee().as_str()).unwrap()
}
fn profiles(setup: &Setup) -> reverie_core::profiles::ProfileDocument {
    reverie_contracts::profiles_v1::decode(
        &fs::read(setup.tree.root.join("control/profiles/profiles.json")).unwrap(),
    )
    .unwrap()
}
#[test]
fn ram_choice_uses_real_canonical_cas_before_preview_without_company_or_policy_mutation() {
    crate::test_process::owning_case!(
        ram_choice_uses_real_canonical_cas_before_preview_without_company_or_policy_mutation
    );
    let setup = Setup::new();
    let fixture = Fixture::new();
    let gate = setup_gate(&setup, &fixture);
    let config = fs::read(setup.tree.root.join("worker.json")).unwrap();
    let company = fs::read(setup.tree.root.join("company.json")).unwrap();
    let journal = fs::read(setup.tree.root.join("control/operations/operations.json")).unwrap();
    let before = profiles(&setup);
    let preview = gate.draft(&eid(&setup), &key(), Some(1536)).unwrap();
    let after = profiles(&setup);
    let selected = after.profiles().get(&setup.employee()).unwrap();
    assert_eq!(after.revision().get(), before.revision().get() + 1);
    assert_eq!(selected.version().get(), 2);
    assert_eq!(selected.resources().memory_mib(), 1536);
    assert_eq!(selected, preview.profile());
    assert_eq!(
        selected.binding().current_session().as_str(),
        setup.oracle["employee"]["sessionId"].as_str().unwrap()
    );
    assert_ne!(
        selected.binding().target_session(),
        before
            .profiles()
            .get(&setup.employee())
            .unwrap()
            .binding()
            .target_session()
    );
    assert_eq!(selected.binding().target_generation().get(), 2);
    assert!(!preview.capacity_held());
    assert!(!preview.native_effects());
    assert_eq!(preview.source_memory_mib(), 512);
    assert_eq!(
        fs::read(setup.tree.root.join("worker.json")).unwrap(),
        config
    );
    assert_eq!(
        fs::read(setup.tree.root.join("company.json")).unwrap(),
        company
    );
    assert_eq!(
        fs::read(setup.tree.root.join("control/operations/operations.json")).unwrap(),
        journal
    );
}
#[test]
fn empty_canonical_store_is_initialized_and_bad_ram_or_stopped_intent_never_puts_a_profile() {
    crate::test_process::owning_case!(
        empty_canonical_store_is_initialized_and_bad_ram_or_stopped_intent_never_puts_a_profile
    );
    let setup = Setup::new();
    let fixture = Fixture::new();
    let gate = setup_gate(&setup, &fixture);
    let path = setup.tree.root.join("control/profiles/profiles.json");
    let before = fs::read(&path).unwrap();
    for value in [0, 511, 1_048_577] {
        assert_eq!(
            gate.draft(&eid(&setup), &key(), Some(value))
                .err()
                .unwrap()
                .code(),
            "RESOURCE_PREPARATION_RAM_REQUEST"
        );
        assert_eq!(fs::read(&path).unwrap(), before);
    }
    let mut row = setup.oracle["employee"].clone();
    row["desiredRunning"] = json!(false);
    setup.tree.write(
        "company.json",
        &serde_json::to_vec(&json!({"employees":[row]})).unwrap(),
    );
    assert_eq!(
        gate.draft(&eid(&setup), &key(), Some(1536))
            .err()
            .unwrap()
            .code(),
        "RESOURCE_PREPARATION_CURRENT_EMPLOYEE_REQUIRED"
    );
    assert_eq!(fs::read(&path).unwrap(), before);
    setup.tree.write(
        "company.json",
        &serde_json::to_vec(&json!({"employees":[setup.oracle["employee"]]})).unwrap(),
    );
    fs::remove_file(&path).unwrap();
    let preview = gate.draft(&eid(&setup), &key(), Some(1536)).unwrap();
    assert_eq!(preview.profile().version().get(), 1);
    assert_eq!(profiles(&setup).revision().get(), 1);
}
#[test]
fn new_ram_choice_invalidates_old_preview_but_cannot_rewrite_a_retained_employee_claim() {
    crate::test_process::owning_case!(
        new_ram_choice_invalidates_old_preview_but_cannot_rewrite_a_retained_employee_claim
    );
    let setup = Setup::new();
    let fixture = Fixture::new();
    let gate = setup_gate(&setup, &fixture);
    let info = fs::metadata(&setup.tree.root).unwrap();
    fixture.original_runtime(
        reverie_contracts::reservation_baseline::OriginalRuntimeTail::from_observed_data(
            [info.dev(), info.ino()],
            vec![],
        ),
    );
    let old = gate.draft(&eid(&setup), &key(), Some(1536)).unwrap();
    let next_key = JournalId::parse("44444444-2222-4333-8444-555555555555").unwrap();
    let new = gate.draft(&eid(&setup), &next_key, Some(2048)).unwrap();
    assert_ne!(old.target_session(), new.target_session());
    assert_eq!(new.profile().version().get(), 3);
    assert_eq!(
        gate.retain_draft(&old.draft_id(), &old.digest())
            .err()
            .unwrap()
            .code(),
        "RESOURCE_PREPARATION_DRAFT_CHANGED"
    );
    let held = gate.retain_draft(&new.draft_id(), &new.digest()).unwrap();
    let path = setup.tree.root.join("control/profiles/profiles.json");
    let before = fs::read(&path).unwrap();
    assert_eq!(
        gate.draft(&eid(&setup), &key(), Some(3072))
            .err()
            .unwrap()
            .code(),
        "RESOURCE_PREPARATION_EMPLOYEE_CLAIM_RETAINED"
    );
    assert_eq!(fs::read(path).unwrap(), before);
    held.close().unwrap();
}
#[test]
fn late_whole_company_drift_refuses_before_put_and_numeric_cpu_kind_comes_from_current_policy() {
    crate::test_process::owning_case!(
        late_whole_company_drift_refuses_before_put_and_numeric_cpu_kind_comes_from_current_policy
    );
    let setup = Setup::new();
    let fixture = Fixture::new();
    let gate = setup_gate(&setup, &fixture);
    let directory = setup.tree.root.join("control/profiles");
    let company = setup.tree.root.join("company.json");
    let before = fs::read(directory.join("profiles.json")).unwrap();
    fixture.on_query(move || {
        let opened = fs::read_dir("/proc/self/fd")
            .unwrap()
            .filter_map(|entry| fs::read_link(entry.unwrap().path()).ok())
            .any(|path| path == directory);
        if opened {
            let mut value: Value = serde_json::from_slice(&fs::read(&company).unwrap()).unwrap();
            value["unrelatedRootData"] = json!("changed");
            fs::write(&company, serde_json::to_vec(&value).unwrap()).unwrap();
        }
        Ok(())
    });
    assert_eq!(
        gate.draft(&eid(&setup), &key(), Some(1536))
            .err()
            .unwrap()
            .code(),
        "RESOURCE_PREPARATION_SOURCE_CHANGED"
    );
    assert_eq!(
        fs::read(setup.tree.root.join("control/profiles/profiles.json")).unwrap(),
        before
    );
    let mut setup = Setup::new();
    let mut config: Value = serde_json::from_slice(&setup.tree.raw).unwrap();
    config["cpus"] = json!(-0.0);
    setup.tree.raw = serde_json::to_vec(&config).unwrap();
    setup.tree.write("worker.json", &setup.tree.raw);
    let source = worker_config::decode(&setup.tree.raw).unwrap();
    let session = reverie_core::ids::ProfileSessionId::parse(
        setup.oracle["employee"]["sessionId"].as_str().unwrap(),
    )
    .unwrap();
    let effective = crate::resource_staging::effective_config(source, &session).unwrap();
    setup.rows[1]["Config"]["Labels"]["reverie.worker-policy"] =
        json!(worker_config::policy_digest(&effective).to_hex());
    let fixture = Fixture::new();
    let gate = setup_gate(&setup, &fixture);
    let selected = gate.draft(&eid(&setup), &key(), Some(1536)).unwrap();
    assert!(
        String::from_utf8(
            reverie_contracts::profiles_v1::encode_profile(selected.profile()).unwrap()
        )
        .unwrap()
        .contains("\"cpus\":-0.0")
    );
}
#[test]
fn preview_loss_after_successful_profile_cas_retains_profile_without_a_capacity_claim() {
    crate::test_process::owning_case!(
        preview_loss_after_successful_profile_cas_retains_profile_without_a_capacity_claim
    );
    let setup = Setup::new();
    let fixture = Fixture::new();
    let gate = setup_gate(&setup, &fixture);
    let path = setup.tree.root.join("control/profiles/profiles.json");
    fixture.on_query(move || {
        let document = reverie_contracts::profiles_v1::decode(&fs::read(&path).unwrap()).unwrap();
        if document
            .profiles()
            .values()
            .any(|profile| profile.version().get() == 2)
        {
            Err(ObserverError::Refused("OWNED_PREVIEW_AFTER_PROFILE_CAS"))
        } else {
            Ok(())
        }
    });
    assert_eq!(
        gate.draft(&eid(&setup), &key(), Some(1536))
            .err()
            .unwrap()
            .code(),
        "OWNED_PREVIEW_AFTER_PROFILE_CAS"
    );
    let document = profiles(&setup);
    assert_eq!(
        document
            .profiles()
            .get(&setup.employee())
            .unwrap()
            .resources()
            .memory_mib(),
        1536
    );
    assert_eq!(
        document
            .profiles()
            .get(&setup.employee())
            .unwrap()
            .version()
            .get(),
        2
    );
    assert!(
        operations_v1::decode(
            &fs::read(setup.tree.root.join("control/operations/operations.json")).unwrap()
        )
        .unwrap()
        .operations()
        .is_empty()
    );
    assert!(gate.inner.state.lock().unwrap().active.is_none());
}
#[test]
fn target_generation_overflow_is_checked_after_final_native_and_company_fences() {
    crate::test_process::owning_case!(
        target_generation_overflow_is_checked_after_final_native_and_company_fences
    );
    let setup = Setup::new();
    let fixture = Fixture::new();
    let gate = setup_gate(&setup, &fixture);
    let mut row = setup.oracle["employee"].clone();
    row["sessionGeneration"] = json!(reverie_core::revision::JS_SAFE_MAX);
    setup.tree.write(
        "company.json",
        &serde_json::to_vec(&json!({"employees":[row]})).unwrap(),
    );
    let before = fs::read(setup.tree.root.join("control/profiles/profiles.json")).unwrap();
    assert_eq!(
        gate.draft(&eid(&setup), &key(), Some(1536))
            .err()
            .unwrap()
            .code(),
        "VERSION_TYPE"
    );
    let profiles = setup.tree.root.join("control/profiles");
    let company = setup.tree.root.join("company.json");
    fixture.on_query(move || {
        if fs::read_dir("/proc/self/fd")
            .unwrap()
            .filter_map(|entry| fs::read_link(entry.unwrap().path()).ok())
            .any(|path| path == profiles)
        {
            let mut data: Value = serde_json::from_slice(&fs::read(&company).unwrap()).unwrap();
            data["lateRootChange"] = json!(true);
            fs::write(&company, serde_json::to_vec(&data).unwrap()).unwrap();
        }
        Ok(())
    });
    assert_eq!(
        gate.draft(&eid(&setup), &key(), Some(1536))
            .err()
            .unwrap()
            .code(),
        "RESOURCE_PREPARATION_SOURCE_CHANGED",
        "earlier real metadata drift wins over late put validation"
    );
    assert_eq!(
        fs::read(setup.tree.root.join("control/profiles/profiles.json")).unwrap(),
        before
    );
}
