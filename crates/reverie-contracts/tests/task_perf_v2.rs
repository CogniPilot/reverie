use reverie_contracts::rootless::RootlessConfig;
use reverie_contracts::task_perf_v1::{
    PerfSystem, TaskPerfArtifactData, TaskPerfConfiguration, TaskPerfError, TaskPerfManifest,
    TaskPerfPolicy, TaskPerfProfile, produce_task_perf_for_policy,
};
use reverie_core::ids::ProfileEmployeeId;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const BASE: &[u8] =
    br#"{"defaultAction":"SCMP_ACT_ERRNO","syscalls":[],"preserved":{"opaque":true}}"#;
const EMPLOYEE: &str = "11111111-1111-4111-8111-111111111111";
fn produced(policy: TaskPerfPolicy) -> (Value, Vec<u8>) {
    let result = produce_task_perf_for_policy(
        policy,
        "/nix/store/base/profile.json",
        "/nix/store/selected/profile.json",
        PerfSystem::X86_64Linux,
        BASE,
    )
    .unwrap();
    (
        serde_json::from_slice(result.manifest()).unwrap(),
        result.profile().to_vec(),
    )
}
fn verify(manifest: &Value, profile: &[u8]) -> Result<TaskPerfArtifactData, TaskPerfError> {
    let manifest = TaskPerfManifest::decode(
        &serde_json::to_vec(manifest).unwrap(),
        PerfSystem::X86_64Linux,
    )?;
    TaskPerfArtifactData::verify(manifest, BASE, profile)
}
fn config(policy: TaskPerfPolicy, artifact: &TaskPerfArtifactData) -> TaskPerfConfiguration {
    TaskPerfConfiguration::decode(
        &serde_json::to_vec(&json!({
            "uid":1000,"gid":100,"mounts":[],"employeePerfPolicies":{EMPLOYEE:policy.name()},
            "rootlessDocker":{"enabled":true,"seccompProfile":artifact.manifest().base_profile(),
                "seccompSha256":artifact.manifest().base_sha256()},"opaque":[1,true,"keep"]
        }))
        .unwrap(),
    )
    .unwrap()
}
#[test]
fn v2_is_exactly_one_rule_with_both_closed_predicates_and_preserved_base() {
    let (manifest, profile) = produced(TaskPerfPolicy::TaskV2);
    let artifact = verify(&manifest, &profile).unwrap();
    assert_eq!(artifact.manifest().policy(), TaskPerfPolicy::TaskV2);
    assert_eq!(manifest["version"], 2);
    assert_eq!(manifest["purpose"], "worker-task-perf-profile-v2");
    let value: Value = serde_json::from_slice(&profile).unwrap();
    assert_eq!(value["preserved"], json!({"opaque":true}));
    assert_eq!(
        value["syscalls"],
        json!([{
            "names":["perf_event_open"],"action":"SCMP_ACT_ALLOW","args":[
                {"index":1,"value":2147483648u64,"valueTwo":0,"op":"SCMP_CMP_MASKED_EQ"},
                {"index":4,"value":18446744073709551604u64,"valueTwo":0,"op":"SCMP_CMP_MASKED_EQ"}
            ]
        }])
    );
}
#[test]
fn versions_cannot_cross_projection_marker_manifest_or_derivative() {
    let employee = ProfileEmployeeId::parse(EMPLOYEE).unwrap();
    for policy in [TaskPerfPolicy::TaskV1, TaskPerfPolicy::TaskV2] {
        let (manifest, profile) = produced(policy);
        let artifact = verify(&manifest, &profile).unwrap();
        let other = if policy == TaskPerfPolicy::TaskV1 {
            TaskPerfPolicy::TaskV2
        } else {
            TaskPerfPolicy::TaskV1
        };
        assert!(matches!(
            config(other, &artifact).project(Some(&employee), Some(&artifact)),
            Err(TaskPerfError::PolicyArtifact)
        ));
        let projection = config(policy, &artifact)
            .project(Some(&employee), Some(&artifact))
            .unwrap();
        let rootless = RootlessConfig::capture(projection.configuration().clone()).unwrap();
        rootless.check_profile(&profile, Some(&artifact)).unwrap();
        let mut wrong: Value = serde_json::from_slice(
            &reverie_contracts::worker_config::encode_config(projection.configuration()),
        )
        .unwrap();
        wrong["_taskPerfPolicy"] = json!(other.name());
        let wrong = TaskPerfConfiguration::decode(&serde_json::to_vec(&wrong).unwrap()).unwrap();
        assert!(matches!(
            wrong.recognized(&artifact, &TaskPerfProfile::decode(&profile).unwrap()),
            Err(TaskPerfError::PolicyArtifact)
        ));
        let (_, other_profile) = produced(other);
        let mut wrong_manifest = manifest.clone();
        wrong_manifest["profileSHA256"] = json!(format!("{:x}", Sha256::digest(&other_profile)));
        assert!(matches!(
            verify(&wrong_manifest, &other_profile),
            Err(TaskPerfError::Derivative)
        ));
        wrong_manifest = manifest;
        wrong_manifest["purpose"] = json!(if other == TaskPerfPolicy::TaskV1 {
            "worker-task-perf-profile-v1"
        } else {
            "worker-task-perf-profile-v2"
        });
        assert!(verify(&wrong_manifest, &profile).is_err());
    }
}
#[test]
fn split_or_missing_predicates_unknown_flags_and_v1_or_v2_derivatives_refuse() {
    let (manifest, profile) = produced(TaskPerfPolicy::TaskV2);
    let original: Value = serde_json::from_slice(&profile).unwrap();
    let mut mutations = Vec::new();
    let mut split = original.clone();
    let rule = &original["syscalls"][0];
    split["syscalls"] = json!([
        {"names":["perf_event_open"],"action":"SCMP_ACT_ALLOW","args":[rule["args"][0].clone()]},
        {"names":["perf_event_open"],"action":"SCMP_ACT_ALLOW","args":[rule["args"][1].clone()]}
    ]);
    mutations.push(split);
    for (index, mask) in [(0, 0u64), (0, 0x7fff_ffff), (1, 4), (1, 0xffff_fff4)] {
        let mut value = original.clone();
        value["syscalls"][0]["args"][index]["value"] = json!(mask);
        mutations.push(value);
    }
    for value in mutations {
        let bytes = serde_json::to_vec(&value).unwrap();
        let mut fixed = manifest.clone();
        fixed["profileSHA256"] = json!(format!("{:x}", Sha256::digest(&bytes)));
        assert!(matches!(
            verify(&fixed, &bytes),
            Err(TaskPerfError::Derivative)
        ));
    }
    let (_, legacy) = produced(TaskPerfPolicy::TaskV1);
    assert!(matches!(
        TaskPerfProfile::decode(&legacy)
            .unwrap()
            .derivative_for_policy(TaskPerfPolicy::TaskV2),
        Err(TaskPerfError::AlreadyApplied)
    ));
}
