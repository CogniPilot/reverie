//! Pure engine-readback DATA controls. No container, profile, image approval,
//! process owner or readiness grant is created by these fixtures.
use reverie_contracts::{
    task_perf_v1::{TaskPerfProfile, projected_selection},
    worker_cold_tmp::RetainedInspection,
    worker_config,
};
use reverie_core::{
    ids::{ContainerId, ProfileSessionId},
    task_perf::TaskPerfPolicy,
};
use serde_json::{Value, json};

fn fixture() -> (Value, Value) {
    let rows: Vec<Value> = serde_json::from_str(include_str!(
        "fixtures/worker-cold-retained-confirmation-python.json"
    ))
    .unwrap();
    let original = rows
        .into_iter()
        .find(|row| row["accepted"] == true)
        .unwrap();
    let mut row: Value = serde_json::from_str(original["raw"].as_str().unwrap()).unwrap();
    row[0]["HostConfig"] = json!({"ReadonlyRootfs":true,"Privileged":false,
        "CapDrop":["ALL"],"CapAdd":["CAP_SETUID","CAP_SETGID"],
        "SecurityOpt":["seccomp={\"defaultAction\":\"SCMP_ACT_ERRNO\",\"syscalls\":[]}"]});
    (original, row)
}
fn decode(original: &Value, row: &Value) -> RetainedInspection {
    let source = worker_config::decode(&serde_json::to_vec(&original["source"]).unwrap()).unwrap();
    RetainedInspection::decode(
        &serde_json::to_vec(row).unwrap(),
        &ContainerId::parse(original["cid"].as_str().unwrap()).unwrap(),
        &source,
        &ProfileSessionId::parse(original["session"].as_str().unwrap()).unwrap(),
        original["employee"].as_str(),
    )
    .unwrap()
}
#[test]
fn readback_selects_the_exact_embedded_profile_without_claiming_native_enforcement() {
    let (original, row) = fixture();
    let profile = decode(&original, &row).perf_profile().unwrap();
    let expected =
        TaskPerfProfile::decode(br#"{"defaultAction":"SCMP_ACT_ERRNO","syscalls":[]}"#).unwrap();
    assert!(profile.equivalent(&expected));
}
#[test]
fn writable_root_privilege_and_any_capsule_shadowing_refuse() {
    let (original, row) = fixture();
    for (field, value) in [("ReadonlyRootfs", false), ("Privileged", true)] {
        let mut changed = row.clone();
        changed[0]["HostConfig"][field] = json!(value);
        assert!(
            decode(&original, &changed).perf_profile().is_err(),
            "{field}"
        );
    }
    for destination in [
        "/",
        "/opt",
        "/opt/reverie",
        "/opt/reverie/perf",
        "/opt/reverie/perf/bin/perf",
        "/opt/reverie/./perf/lib",
        "/x/../opt/reverie/perf",
        "/opt/rvprf",
        "/opt/rvprf/preload.off",
        "/opt/rvprf/arbitrary-library",
    ] {
        let mut changed = row.clone();
        changed[0]["Mounts"].as_array_mut().unwrap().push(json!({
            "Type":"bind","Source":"/fixture/other","Destination":destination,"RW":false}));
        assert!(
            decode(&original, &changed).perf_profile().is_err(),
            "{destination}"
        );
    }
    let mut unrelated = row;
    unrelated[0]["Mounts"].as_array_mut().unwrap().push(json!({
        "Type":"bind","Source":"/fixture/other","Destination":"/opt/reverie/perf-other","RW":true}));
    assert!(decode(&original, &unrelated).perf_profile().is_ok());
}

#[test]
fn guest_mounts_use_posix_roots_and_literal_backslashes_on_every_host() {
    let (original, row) = fixture();
    for destination in [
        "/workspace",
        "/C:/worker",
        r"/opt\reverie\perf",
        r"/opt/reverie/perf\tools",
    ] {
        let mut changed = row.clone();
        changed[0]["Mounts"] = json!([{"Destination":destination}]);
        assert!(
            decode(&original, &changed).perf_profile().is_ok(),
            "{destination}"
        );
    }
    for destination in [
        r"C:\worker",
        r"\\server\share",
        "//opt/reverie/perf",
        "///opt/reverie/perf/bin",
        "//opt/rvprf/preload.off",
        "/unrelated/../workspace",
    ] {
        let mut changed = row.clone();
        changed[0]["Mounts"] = json!([{"Destination":destination}]);
        assert!(
            decode(&original, &changed).perf_profile().is_err(),
            "{destination}"
        );
    }
}
#[test]
fn ambiguous_profiles_and_capability_expansion_refuse() {
    let (original, row) = fixture();
    for (field, value) in [
        ("CapAdd", json!(["SETUID", "SETGID", "SYS_ADMIN"])),
        ("CapAdd", json!(["SETUID", "SETGID", "SETGID"])),
        ("CapDrop", json!([])),
        ("SecurityOpt", json!(["seccomp=unconfined"])),
        ("SecurityOpt", json!(["seccomp={}", "seccomp={}"])),
    ] {
        let mut changed = row.clone();
        changed[0]["HostConfig"][field] = value;
        assert!(
            decode(&original, &changed).perf_profile().is_err(),
            "{field}"
        );
    }
}
#[test]
fn projected_marker_preserves_unselected_and_legacy_paths_and_rejects_malformed_markers() {
    for (raw, expected) in [
        (br#"{}"#.as_slice(), None),
        (
            br#"{"_taskPerfPolicy":"task-v1"}"#.as_slice(),
            Some(TaskPerfPolicy::TaskV1),
        ),
        (
            br#"{"_taskPerfPolicy":"task-v2"}"#.as_slice(),
            Some(TaskPerfPolicy::TaskV2),
        ),
    ] {
        assert_eq!(
            projected_selection(&worker_config::decode(raw).unwrap()).unwrap(),
            expected
        );
    }
    for raw in [
        br#"{"_taskPerfPolicy":null}"#.as_slice(),
        br#"{"_taskPerfPolicy":""}"#.as_slice(),
    ] {
        assert!(projected_selection(&worker_config::decode(raw).unwrap()).is_err());
    }
}
