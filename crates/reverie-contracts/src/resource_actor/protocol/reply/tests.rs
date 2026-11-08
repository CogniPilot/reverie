//! Pure reply/schema controls. Native-looking values here are DATA only;
//! these fixtures create no Auth, native observer, lease, claim or permission.
use super::*;
use crate::{
    reservation_engine::{InventoryRows, NativeLimitBinding},
    worker_config,
};
use reverie_core::{
    decimal::UnsignedInteger,
    ids::{ContainerId, ProfileEmployeeId, ProfileSessionId},
    posix_path::PosixPath,
    profiles::ProfileBinding,
    resources::{BudgetMode, CpuQuota, ResourcePolicy},
    revision::{Generation, ProfileVersion},
};
use serde_json::{Value as Json, json};
const EMPLOYEE: &str = "11111111-2222-4333-8444-555555555555";
const REQUEST: &str = "22222222-2222-4333-8444-555555555555";
const DRAFT: &str = "44444444-2222-4333-8444-555555555555";
const OPERATION: &str = "55555555-2222-4333-8444-555555555555";
const RESERVATION: &str = "66666666-2222-4333-8444-555555555555";
const TARGET: &str = "77777777-2222-4333-8444-555555555555";
const CURRENT: &str = "88888888-2222-4333-8444-555555555555";
fn request(employee: &str, memory: u32) -> ResourceOperationRequest {
    let value = json!({"kind":"resource-operation","requestId":REQUEST,"verb":"draft",
        "employeeId":employee,"idempotencyKey":DRAFT,"memoryMiB":memory});
    ResourceOperationRequest::decode(
        &HumanFrame::decode(&serde_json::to_vec(&value).unwrap()).unwrap(),
    )
    .unwrap()
}
fn policy(cpu: CpuQuota, version: u64) -> (ResourceProfile, RamMigrationPolicy) {
    let binding = ProfileBinding::try_new(
        ProfileEmployeeId::parse(EMPLOYEE).unwrap(),
        ProfileSessionId::parse(CURRENT).unwrap(),
        ProfileSessionId::parse(TARGET).unwrap(),
        Generation::try_new(1).unwrap(),
        Generation::try_new(2).unwrap(),
    )
    .unwrap();
    let resources =
        ResourcePolicy::try_new(BudgetMode::Admission, 49_152, 8, cpu, 49_152, 8192).unwrap();
    let profile = ResourceProfile::new(
        ProfileVersion::try_new(version).unwrap(),
        resources,
        binding,
    );
    let cid = "a".repeat(64);
    let row = json!({"Id":cid,"Name":format!("/fixture-agent-{CURRENT}"),"Image":format!("sha256:{}","b".repeat(64)),
        "State":{"Running":true,"Pid":42},"Config":{"Labels":{}},"Mounts":[],
        "HostConfig":{"Memory":536870912u64,"MemorySwap":536870912u64,"PidsLimit":8,"NanoCpus":0}});
    let rows = InventoryRows::decode(
        &[ContainerId::parse(&cid).unwrap()],
        &[serde_json::to_string(&json!([row])).unwrap()],
    )
    .unwrap();
    let row = &rows.rows()[0];
    let declared = row.declarations(&UnsignedInteger::from_u64(0)).unwrap();
    let native = NativeLimitBinding::from_observed_data(
        row,
        &declared,
        "41",
        &PosixPath::from_scalar_text("fixture/cgroup"),
        None,
    )
    .unwrap();
    let config = worker_config::decode(
        &serde_json::to_vec(&json!({"budgetMode":"admission","memoryMiB":512,
        "pidsLimit":8,"cpus":0,"poolMemoryMiB":49152,"poolTasksMax":8192}))
        .unwrap(),
    )
    .unwrap();
    let policy = RamMigrationPolicy::from_observed(&profile, &native, &config).unwrap();
    (profile, policy)
}
fn preview(
    request: &ResourceOperationRequest,
    profile: &ResourceProfile,
    policy: &RamMigrationPolicy,
) -> Result<HumanFrame> {
    request.preview_reply(RamPreviewFields {
        draft_id: &JournalId::parse(DRAFT).unwrap(),
        operation_id: &JournalId::parse(OPERATION).unwrap(),
        reservation_id: &JournalId::parse(RESERVATION).unwrap(),
        profile,
        preview_digest: &JournalDigest::parse(&"c".repeat(64)).unwrap(),
        ram_policy: policy,
        source_memory_mib: 512,
    })
}
#[test]
fn preview_reply_binds_original_request_profile_and_actual_selected_digest_data() {
    let request = request(EMPLOYEE, 49_152);
    let (profile, policy) = policy(CpuQuota::from_integer(0).unwrap(), 1);
    let value: Json = serde_json::from_slice(
        &preview(&request, &profile, &policy)
            .unwrap()
            .canonical()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(value["requestId"], REQUEST);
    assert_eq!(value["kind"], "resource-result");
    let value = &value["value"];
    assert_eq!(value["draftId"], DRAFT);
    assert_eq!(value["operationId"], OPERATION);
    assert_eq!(value["reservationId"], RESERVATION);
    assert_eq!(value["targetSid"], TARGET);
    assert_eq!(value["ramPolicyDigest"], policy.digest().as_str());
    assert_eq!(
        value["profileDigest"],
        profiles_v1::profile_digest(&profile).unwrap().to_hex()
    );
    assert_eq!(value["resources"]["budgetMode"], "admission");
    assert_eq!(value["sourceMemoryMiB"], 512);
    assert_eq!(value["capacityHeld"], false);
    assert_eq!(value["nativeEffects"], false);
    assert_eq!(value.as_object().unwrap().len(), 12);
}
#[test]
fn preview_reply_rejects_foreign_employee_memory_and_profile_substitution() {
    let (profile, policy) = policy(CpuQuota::from_integer(0).unwrap(), 1);
    assert!(preview(&request(RESERVATION, 49_152), &profile, &policy).is_err());
    assert!(preview(&request(EMPLOYEE, 512), &profile, &policy).is_err());
    let changed = ResourceProfile::new(
        ProfileVersion::try_new(2).unwrap(),
        profile.resources().clone(),
        profile.binding().clone(),
    );
    assert!(preview(&request(EMPLOYEE, 49_152), &changed, &policy).is_err());
}
#[test]
fn preview_reply_preserves_full_version_and_normalizes_negative_zero_only_on_wire() {
    let request = request(EMPLOYEE, 49_152);
    let (profile, policy) = policy(CpuQuota::from_float(-0.0).unwrap(), u64::MAX);
    let raw = preview(&request, &profile, &policy)
        .unwrap()
        .canonical()
        .unwrap();
    let value: Json = serde_json::from_slice(&raw).unwrap();
    assert_eq!(value["value"]["profileVersion"], u64::MAX.to_string());
    assert_eq!(value["value"]["resources"]["cpus"], 0);
    assert!(!String::from_utf8(raw).unwrap().contains("\"cpus\":-0"));
    assert!(
        String::from_utf8(profiles_v1::encode_profile(&profile).unwrap())
            .unwrap()
            .contains("\"cpus\":-0.0")
    );
}
#[test]
fn wire_normalization_keeps_distinct_original_profile_digests() {
    let request = request(EMPLOYEE, 49_152);
    let (integer, ip) = policy(CpuQuota::from_integer(0).unwrap(), 1);
    let (float, fp) = policy(CpuQuota::from_float(0.0).unwrap(), 1);
    let integer: Json = serde_json::from_slice(
        &preview(&request, &integer, &ip)
            .unwrap()
            .canonical()
            .unwrap(),
    )
    .unwrap();
    let float: Json =
        serde_json::from_slice(&preview(&request, &float, &fp).unwrap().canonical().unwrap())
            .unwrap();
    assert_eq!(integer["value"]["resources"], float["value"]["resources"]);
    assert_ne!(
        integer["value"]["profileDigest"],
        float["value"]["profileDigest"]
    );
    assert_ne!(
        integer["value"]["ramPolicyDigest"],
        float["value"]["ramPolicyDigest"]
    );
}
#[test]
fn refusal_reply_has_original_correlation_and_closed_bounded_reason() {
    let request = request(EMPLOYEE, 49_152);
    let frame = request
        .refusal_reply("RESOURCE_RAM_NATIVE_CONTINUATION_REQUIRED")
        .unwrap();
    let value: Json = serde_json::from_slice(&frame.canonical().unwrap()).unwrap();
    assert_eq!(
        value,
        json!({"kind":"resource-refused","requestId":REQUEST,"reason":"RESOURCE_RAM_NATIVE_CONTINUATION_REQUIRED"})
    );
    for reason in [
        "".to_owned(),
        "lowercase".to_owned(),
        "BAD/CODE".to_owned(),
        "A".repeat(97),
    ] {
        assert!(request.refusal_reply(&reason).is_err());
    }
}
