use super::*;
fn ram_preparing(
    hard: u32,
    high: Option<u32>,
) -> (
    Setup,
    Arc<Fixture>,
    ReservationGate,
    RetainedPreparation,
    PathBuf,
) {
    let mut setup = Setup::new();
    let mut config: Value = serde_json::from_slice(&setup.tree.raw).unwrap();
    config["poolMemoryMiB"] = json!(49_152);
    config["memoryMiB"] = json!(hard);
    if let Some(high) = high {
        config["employeeMemoryPolicies"] =
            json!({setup.employee().as_str():{"memoryHighMiB":high,"swapMiB":0}});
    }
    setup.tree.raw = serde_json::to_vec(&config).unwrap();
    setup.tree.write("worker.json", &setup.tree.raw);
    setup.tree.marker(&config);
    let profile_path = "control/profiles/profiles.json";
    let mut profiles: Value =
        serde_json::from_slice(&fs::read(setup.tree.root.join(profile_path)).unwrap()).unwrap();
    let target = &mut profiles["profiles"][setup.employee().as_str()]["resources"];
    target["budgetMode"] = json!("pool");
    target["memoryMiB"] = json!(49_152);
    target["poolMemoryMiB"] = json!(49_152);
    target["cpus"] = json!(0);
    setup
        .tree
        .write(profile_path, &serde_json::to_vec(&profiles).unwrap());
    setup.rows[1]["HostConfig"]["Memory"] = json!(u64::from(hard) * 1_048_576);
    setup.rows[1]["HostConfig"]["MemorySwap"] = json!(u64::from(hard) * 1_048_576);
    let old =
        ProfileSessionId::parse(setup.oracle["employee"]["sessionId"].as_str().unwrap()).unwrap();
    let effective = crate::resource_staging::effective_config(
        worker_config::decode(&setup.tree.raw).unwrap(),
        &old,
    )
    .unwrap();
    setup.rows[1]["Config"]["Labels"]["reverie.worker-policy"] =
        json!(worker_config::policy_digest(&effective).to_hex());
    let fixture = Fixture::new();
    // Kernel/engine observations remain the accepted synthetic fixture. The
    // admission, R stores, file CAS, reload, acknowledgement and closes are real.
    fixture.host_memory_facts("MemTotal: 67108864 kB\nMemAvailable: 33554432 kB\n");
    preparing_using(setup, fixture)
}
#[test]
fn real_ram_migration_cas_binds_old_allocation_and_changes_only_target_session_soft_policy() {
    crate::test_process::owning_case!(
        real_ram_migration_cas_binds_old_allocation_and_changes_only_target_session_soft_policy
    );
    let (setup, _fixture, gate, mut claim, path) = ram_preparing(512, None);
    let policy = claim.ram_migration_policy().unwrap();
    assert_eq!(policy.memory().policy().memory_high_mib(), Some(512));
    assert_eq!(policy.memory().policy().swap_mib(), 0);
    let before: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    let profiles = fs::read(setup.tree.root.join("control/profiles/profiles.json")).unwrap();
    let marker = fs::read(
        setup
            .tree
            .root
            .join("state/resource-reservation-control.json"),
    )
    .unwrap();
    let old = claim.profile().binding().current_session().clone();
    let original =
        crate::resource_staging::effective_config(claim.source_configuration().clone(), &old)
            .unwrap();
    let receipt = claim.commit_ram_configuration(&policy).unwrap();
    receipt
        .assert_gate_current(&gate, claim.operation_id())
        .unwrap();
    let after: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    let target = claim.profile().binding().target_session();
    assert_eq!(after["sessionResources"][target.as_str()]["version"], 2);
    assert_eq!(
        after["sessionResources"][target.as_str()]["resources"]["memoryMiB"],
        49_152
    );
    assert_eq!(
        after["sessionResources"][target.as_str()]["memoryPolicy"]["memoryHighMiB"],
        512
    );
    assert_eq!(
        after.get("employeeMemoryPolicies"),
        before.get("employeeMemoryPolicies")
    );
    let old_after = crate::resource_staging::effective_config(
        load_owner_config(&path).unwrap().configuration().clone(),
        &old,
    )
    .unwrap();
    assert_eq!(
        worker_config::encode_config(&old_after),
        worker_config::encode_config(&original)
    );
    assert_eq!(
        fs::read(setup.tree.root.join("control/profiles/profiles.json")).unwrap(),
        profiles
    );
    assert_eq!(
        fs::read(
            setup
                .tree
                .root
                .join("state/resource-reservation-control.json")
        )
        .unwrap(),
        marker
    );
    assert_eq!(claim.operation().state(), OperationState::Prepared);
    assert!(claim.operation().reservation_retained());
    assert!(!claim.operation().retry_allowed());
    claim.close().unwrap();
}
#[test]
fn real_ram_selection_preserves_existing_high_instead_of_using_already_bursted_hard_cap() {
    crate::test_process::owning_case!(
        real_ram_selection_preserves_existing_high_instead_of_using_already_bursted_hard_cap
    );
    let (_setup, _fixture, _gate, claim, _path) = ram_preparing(1024, Some(512));
    let policy = claim.ram_migration_policy().unwrap();
    assert_eq!(policy.memory().policy().memory_high_mib(), Some(512));
    assert_eq!(policy.profile().resources().memory_mib(), 49_152);
    assert_eq!(policy.profile().resources().cpus().nano_cpus(), 0);
    claim.close().unwrap();
}
#[test]
fn different_actual_source_ram_selection_refuses_before_config_attempt_and_preserves_reservation() {
    crate::test_process::owning_case!(
        different_actual_source_ram_selection_refuses_before_config_attempt_and_preserves_reservation
    );
    let (setup, _fixture, _gate, mut claim, path) = ram_preparing(512, None);
    let (_other_setup, _other_fixture, _other_gate, other, _other_path) = ram_preparing(512, None);
    let foreign = other.ram_migration_policy().unwrap();
    let original = fs::read(&path).unwrap();
    let journal_path = setup.tree.root.join("control/operations/operations.json");
    let journal = fs::read(&journal_path).unwrap();
    assert_eq!(
        claim
            .commit_ram_configuration(&foreign)
            .err()
            .unwrap()
            .code(),
        "RAM_MIGRATION_APPROVED_SELECTION_CHANGED"
    );
    assert_eq!(fs::read(&path).unwrap(), original);
    assert_eq!(fs::read(&journal_path).unwrap(), journal);
    assert!(
        !setup
            .tree
            .root
            .join(format!(
                "control/operations/config-attempt-{}.json",
                claim.operation_id().as_str()
            ))
            .exists()
    );
    assert!(claim.operation().reservation_retained());
    claim.close().unwrap();
    other.close().unwrap();
}

#[test]
fn ram_config_cas_rebind_retains_original_bytes_preimage_and_one_shot_claim() {
    crate::test_process::owning_case!(
        ram_config_cas_rebind_retains_original_bytes_preimage_and_one_shot_claim
    );
    let (setup, fixture, _gate, mut claim, path) = ram_preparing(512, None);
    let policy = claim.ram_migration_policy().unwrap();
    let bytes = fs::read(&path).unwrap();
    let saved = bytes.clone();
    let selected = path.clone();
    let parent = path.parent().unwrap().to_owned();
    let mut changed = false;
    fixture.on_query(move || {
        let staged = fs::read_dir(&parent).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .as_encoded_bytes()
                .starts_with(b".resource-preparing-")
        });
        if staged && !changed {
            changed = true;
            fs::rename(&selected, parent.join("owned-ram-original-evidence")).unwrap();
            fs::write(&selected, &saved).unwrap();
            fs::set_permissions(&selected, fs::Permissions::from_mode(0o600)).unwrap();
        }
        Ok(())
    });
    assert_eq!(
        claim
            .commit_ram_configuration(&policy)
            .err()
            .unwrap()
            .code(),
        "RESOURCE_PREPARATION_CONFIG_UNCERTAIN_KEEP_ALL_EVIDENCE"
    );
    assert_eq!(fs::read(&path).unwrap(), bytes);
    assert_eq!(
        fs::read(path.with_file_name("owned-ram-original-evidence")).unwrap(),
        bytes
    );
    assert!(
        setup
            .tree
            .root
            .join(format!(
                "control/operations/config-attempt-{}.json",
                claim.operation_id().as_str()
            ))
            .exists()
    );
    assert_eq!(claim.operation().state(), OperationState::Preparing);
    assert!(claim.operation().reservation_retained());
    assert!(!claim.operation().retry_allowed());
    assert_eq!(
        claim
            .commit_ram_configuration(&policy)
            .err()
            .unwrap()
            .code(),
        "RESOURCE_PREPARATION_ACTIVE_HANDLE_REQUIRED"
    );
}

#[test]
fn actual_source_ram_selection_refuses_unlimited_partial_pool_and_quota_target_data() {
    crate::test_process::owning_case!(
        actual_source_ram_selection_refuses_unlimited_partial_pool_and_quota_target_data
    );
    use reverie_contracts::ram_migration::RamMigrationPolicy;
    use reverie_core::{
        profiles::ResourceProfile,
        resources::{BudgetMode, CpuQuota, ResourcePolicy},
    };
    let (_setup, _fixture, _gate, claim, _path) = ram_preparing(512, None);
    let original = crate::resource_staging::effective_config(
        claim.source_configuration().clone(),
        claim.profile().binding().current_session(),
    )
    .unwrap();
    for (hard, quota) in [(0, 0), (24_576, 0), (49_152, 1)] {
        let resources = ResourcePolicy::try_new(
            BudgetMode::Pool,
            hard,
            claim.profile().resources().pids_limit(),
            CpuQuota::from_integer(quota).unwrap(),
            49_152,
            claim.profile().resources().pool_tasks_max(),
        )
        .unwrap();
        let profile = ResourceProfile::new(
            claim.profile().version(),
            resources,
            claim.profile().binding().clone(),
        );
        assert_eq!(
            RamMigrationPolicy::from_observed(
                &profile,
                claim.original_baseline().native(),
                &original
            )
            .err()
            .unwrap()
            .code(),
            "RAM_MIGRATION_BURST_POOL_REQUIRED"
        );
    }
    let mut changed: Value =
        serde_json::from_slice(&worker_config::encode_config(&original)).unwrap();
    changed["memoryMiB"] = json!(1024);
    assert_eq!(
        RamMigrationPolicy::from_observed(
            claim.profile(),
            claim.original_baseline().native(),
            &worker_config::decode(&serde_json::to_vec(&changed).unwrap()).unwrap()
        )
        .err()
        .unwrap()
        .code(),
        "RAM_MIGRATION_SOURCE_POLICY_CHANGED"
    );
    claim.close().unwrap();
}
