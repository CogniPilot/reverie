//! New provider selection is closed data, never a maintenance/admission grant.
use super::*;
use crate::worker_config;
use reverie_core::ids::{ProfileEmployeeId, ProfileSessionId};

const EMPLOYEE: &str = "22222222-2222-4222-8222-222222222222";
const PEER: &str = "33333333-3333-4333-8333-333333333333";

fn selected() -> serde_json::Value {
    serde_json::json!({
        "version":1,
        "purpose":"reverie-docker-worker-pool-provider-v1",
        "policy":policy()
    })
}
fn configuration(value: serde_json::Value) -> worker_config::EffectiveWorkerConfig {
    worker_config::decode(&serde_json::to_vec(&value).unwrap()).unwrap()
}
#[test]
fn legacy_configuration_remains_unselected_and_byte_identical() {
    let config = configuration(serde_json::json!({"cgroupParent":"reverie-workers.slice"}));
    let before = worker_config::encode_config(&config);
    assert!(WorkerPoolProvider::from_config(&config).unwrap().is_none());
    assert_eq!(before, worker_config::encode_config(&config));
}
#[test]
fn explicit_provider_preserves_the_full_validated_policy() {
    let config = configuration(serde_json::json!({"workerPoolProvider":selected()}));
    let provider = WorkerPoolProvider::from_config(&config).unwrap().unwrap();
    assert_eq!(provider.policy(), &policy());
}
#[test]
fn malformed_or_authority_claiming_provider_never_falls_back_to_legacy() {
    let mut extra = selected();
    extra["ready"] = serde_json::json!(true);
    let mut wrong_version = selected();
    wrong_version["version"] = serde_json::json!(2);
    let mut wrong_purpose = selected();
    wrong_purpose["purpose"] = serde_json::json!(PURPOSE);
    let mut invalid_policy = selected();
    invalid_policy["policy"]["memoryMaxMiB"] = serde_json::json!(0);
    for value in [
        serde_json::Value::Null,
        serde_json::json!({}),
        extra,
        wrong_version,
        wrong_purpose,
        invalid_policy,
    ] {
        let config = configuration(serde_json::json!({"workerPoolProvider":value}));
        assert!(WorkerPoolProvider::from_config(&config).is_err());
    }
}

#[test]
fn editing_one_member_preserves_birth_limits_peer_and_creation_hash() {
    let mut original = selected();
    original["policy"]["employeeMemoryHighMiB"][PEER] = serde_json::json!(3072);
    let before = configuration(serde_json::json!({ "workerPoolProvider": original }));
    let settings = WorkerPoolMemberPolicy::new(8192, 200).unwrap();
    let employee = ProfileEmployeeId::parse(EMPLOYEE).unwrap();
    let after = WorkerPoolProvider::project_member_policy(&before, &employee, settings).unwrap();
    let prior = WorkerPoolProvider::from_config(&before).unwrap().unwrap();
    let selected = WorkerPoolProvider::from_config(&after).unwrap().unwrap();
    assert_eq!(selected.policy(), prior.policy());
    assert_eq!(selected.member_revision(), 1);
    assert_eq!(selected.member_policy(EMPLOYEE), Some(settings));
    assert_eq!(selected.member_policy(PEER), prior.member_policy(PEER));
    assert_ne!(
        crate::reservation_control::domain_digest(&after).unwrap(),
        crate::reservation_control::domain_digest(&before).unwrap()
    );

    let session = ProfileSessionId::parse("44444444-4444-4444-8444-444444444444").unwrap();
    let project = |config| {
        crate::resource_config::ResourceConfiguration::capture(config)
            .unwrap()
            .project(&session, Some(&employee))
            .unwrap()
    };
    assert_eq!(
        worker_config::encode_policy(&project(before.clone())),
        worker_config::encode_policy(&project(after.clone()))
    );

    let restored = WorkerPoolProvider::project_member_policy(
        &after,
        &employee,
        prior.member_policy(EMPLOYEE).unwrap(),
    )
    .unwrap();
    let restored_provider = WorkerPoolProvider::from_config(&restored).unwrap().unwrap();
    assert!(restored_provider.member_overrides().is_empty());
    assert_eq!(restored_provider.member_revision(), 2);
    assert_eq!(
        worker_config::encode_policy(&project(before)),
        worker_config::encode_policy(&project(restored))
    );
}

#[test]
fn editable_provider_refuses_foreign_member_and_unbounded_or_noncanonical_edits() {
    let mut v2 = selected();
    v2["version"] = serde_json::json!(2);
    v2["purpose"] = serde_json::json!("reverie-docker-worker-pool-provider-v2");
    v2["memberRevision"] = serde_json::json!(1);
    for map in [
        serde_json::json!({PEER:{"memoryHighMiB":8192,"cpuWeight":200}}),
        serde_json::json!({EMPLOYEE:{"memoryHighMiB":1536,"cpuWeight":100}}),
        serde_json::json!({EMPLOYEE:{"memoryHighMiB":49152,"cpuWeight":100}}),
        serde_json::json!({EMPLOYEE:{"memoryHighMiB":8192,"cpuWeight":0}}),
        serde_json::json!({EMPLOYEE:{"memoryHighMiB":8192,"cpuWeight":200,"cpuMax":1}}),
        serde_json::Value::Null,
    ] {
        v2["memberOverrides"] = map;
        let config = configuration(serde_json::json!({ "workerPoolProvider": v2 }));
        assert!(WorkerPoolProvider::from_config(&config).is_err());
    }
}

#[test]
fn member_transition_rebinds_control_domain_and_rejects_stale_revision() {
    use crate::{
        reservation_control::{ControlBinding, domain_digest},
        storage_identity::decode_ordered_metadata,
    };
    let option = serde_json::json!({"directory":"/owned/control"});
    let before = configuration(serde_json::json!({
        "workerPoolProvider": selected(),
        "resourceReservations": option,
    }));
    let marker = serde_json::json!({
        "schema":"reverie-resource-control-v1",
        "state":"READY",
        "option":option,
        "directories":{".":[1,2],"profiles":[1,3],"operations":[1,4]},
        "admissionLock":[1,5],
        "stateDirectory":[1,6],
        "locks":{"profiles":[1,7],"operations":[1,8]},
        "configurationDigest":domain_digest(&before).unwrap().to_hex(),
    });
    let marker = decode_ordered_metadata(&serde_json::to_vec(&marker).unwrap()).unwrap();
    let binding = ControlBinding::from_metadata(&marker, &before).unwrap();
    let employee = ProfileEmployeeId::parse(EMPLOYEE).unwrap();
    let desired = WorkerPoolMemberPolicy::new(4096, 300).unwrap();
    let change = WorkerPoolConfigurationTransition::prepare_member_edit(
        &before,
        &binding,
        employee.clone(),
        desired,
        0,
    )
    .unwrap();
    let edit = change.member_edit().unwrap();
    assert_eq!(edit.employee(), &employee);
    assert_eq!(
        edit.previous(),
        WorkerPoolMemberPolicy::new(1536, 100).unwrap()
    );
    assert_eq!(edit.requested(), desired);
    assert_eq!(change.policy(), &policy());
    assert_eq!(
        change.after_binding().domain(),
        &domain_digest(change.after()).unwrap()
    );
    assert_eq!(
        change.after_binding().admission_lock(),
        binding.admission_lock()
    );
    assert_eq!(
        change.after_binding().state_directory(),
        binding.state_directory()
    );
    assert!(change.matches_before_binding(&marker));
    assert!(!change.matches_after_binding(&marker));
    let stale = WorkerPoolConfigurationTransition::prepare_member_edit(
        change.after(),
        change.after_binding(),
        employee,
        WorkerPoolMemberPolicy::new(2048, 100).unwrap(),
        0,
    );
    assert_eq!(
        stale.err().unwrap().code(),
        "WORKER_POOL_MEMBER_REVISION_CHANGED"
    );
}

#[test]
fn existing_birth_threshold_at_hard_ceiling_can_be_read_and_restored() {
    use crate::reservation_engine::ObservedMemoryPolicy;
    let mut original = selected();
    original["policy"]["employeeMemoryHighMiB"][EMPLOYEE] = serde_json::json!(MEMORY_MAX_MIB);
    let before = configuration(serde_json::json!({"workerPoolProvider":original}));
    let employee = ProfileEmployeeId::parse(EMPLOYEE).unwrap();
    let birth = WorkerPoolProvider::from_config(&before)
        .unwrap()
        .unwrap()
        .member_policy(EMPLOYEE)
        .unwrap();
    let effective = configuration(serde_json::json!({
        "budgetMode": "pool",
        "memoryMiB": MEMORY_MAX_MIB,
        "laptopMemoryPolicy": {"swapMiB":0, "memoryHighMiB":MEMORY_MAX_MIB}
    }));
    let observed = ObservedMemoryPolicy::from_effective(&effective)
        .unwrap()
        .unwrap()
        .with_pool_member_policy(birth)
        .unwrap();
    assert_eq!(observed.high(), Some(observed.memory()));
    let lowered = WorkerPoolProvider::project_member_policy(
        &before,
        &employee,
        WorkerPoolMemberPolicy::new(4096, 100).unwrap(),
    )
    .unwrap();
    let restored = WorkerPoolProvider::project_member_policy(&lowered, &employee, birth).unwrap();
    let provider = WorkerPoolProvider::from_config(&restored).unwrap().unwrap();
    assert!(provider.member_overrides().is_empty());
    assert_eq!(provider.member_policy(EMPLOYEE), Some(birth));
    assert_eq!(provider.member_revision(), 2);
}

#[test]
fn replacement_preserves_committed_overrides_and_revision() {
    let mut original = policy();
    original.employee_memory_high_mi_b.insert(PEER.into(), 2048);
    let before = configuration(serde_json::json!({
        "workerPoolProvider":{"version":1,"purpose":"reverie-docker-worker-pool-provider-v1",
        "policy":original}
    }));
    let edited = WorkerPoolProvider::project_member_policy(
        &before,
        &ProfileEmployeeId::parse(EMPLOYEE).unwrap(),
        WorkerPoolMemberPolicy::new(16_384, 300).unwrap(),
    )
    .unwrap();
    let projected = |new_policy: &WorkerPoolPolicy| {
        let field = WorkerPoolProvider::for_replacement(&edited, new_policy).unwrap();
        let wire: serde_json::Value =
            serde_json::from_slice(&worker_config::compact_data(&field)).unwrap();
        WorkerPoolProvider::from_config(&configuration(serde_json::json!({
            "workerPoolProvider":wire
        })))
        .unwrap()
        .unwrap()
    };
    let mut replacement = original.clone();
    replacement.controller_image = format!("sha256:{}", "f".repeat(64));
    replacement
        .employee_memory_high_mi_b
        .insert(PEER.into(), 4096);
    let selected = projected(&replacement);
    assert_eq!(selected.policy(), &replacement);
    assert_eq!(selected.member_revision(), 1);
    assert_eq!(
        selected.member_policy(EMPLOYEE),
        WorkerPoolMemberPolicy::new(16_384, 300).ok()
    );
    assert_eq!(
        selected.member_policy(PEER),
        WorkerPoolMemberPolicy::new(4096, 100).ok()
    );

    replacement
        .employee_memory_high_mi_b
        .insert(EMPLOYEE.into(), 16_384);
    replacement.cpu_weight = 300;
    let selected = projected(&replacement);
    assert!(selected.member_overrides().is_empty());
    assert_eq!(selected.member_revision(), 1);
    replacement.employee_memory_high_mi_b.remove(EMPLOYEE);
    assert!(WorkerPoolProvider::for_replacement(&edited, &replacement).is_err());
}
