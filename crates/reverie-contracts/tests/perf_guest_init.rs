//! Boot-layout DATA controls; these do not execute an init or approve an image.
use reverie_contracts::{
    storage_identity::MetadataText,
    task_perf_capsule::WORKER_INIT,
    worker_cold_tmp::RetainedInspection,
    worker_config,
    worker_launch::{CreateObservations, create_arguments},
};
use reverie_core::ids::{ContainerId, ProfileSessionId};
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
    row[0]["Config"]["Entrypoint"] = json!([WORKER_INIT]);
    row[0]["Config"]["Cmd"] = json!([]);
    row[0]["HostConfig"] = json!({"Init":false});
    (original, row)
}
fn accepted(original: &Value, row: &Value, marker: &str, legacy: bool) -> bool {
    let source = worker_config::decode(&serde_json::to_vec(&original["source"]).unwrap()).unwrap();
    let effective =
        worker_config::decode(&serde_json::to_vec(&json!({"_taskPerfPolicy":marker})).unwrap())
            .unwrap();
    let raw = serde_json::to_vec(row).unwrap();
    let cid = ContainerId::parse(original["cid"].as_str().unwrap()).unwrap();
    let session = ProfileSessionId::parse(original["session"].as_str().unwrap()).unwrap();
    if legacy {
        RetainedInspection::decode(&raw, &cid, &source, &session, original["employee"].as_str())
            .is_ok()
    } else {
        RetainedInspection::decode_started(
            &raw,
            &cid,
            &source,
            &effective,
            &session,
            original["employee"].as_str(),
        )
        .is_ok()
    }
}
#[test]
fn sealed_boot_accepts_only_the_native_entrypoint_without_an_engine_init() {
    let (original, row) = fixture();
    assert!(accepted(&original, &row, "task-v2", false));
    let mut null_command = row.clone();
    null_command[0]["Config"]["Cmd"] = Value::Null;
    assert!(accepted(&original, &null_command, "task-v2", false));
    for (pointer, value) in [
        ("/0/Config/Entrypoint", json!(["/bin/sleep"])),
        ("/0/Config/Cmd", json!(["infinity"])),
        ("/0/HostConfig/Init", json!(true)),
        ("/0/HostConfig/Init", Value::Null),
    ] {
        let mut changed = row.clone();
        *changed.pointer_mut(pointer).unwrap() = value;
        assert!(
            !accepted(&original, &changed, "task-v2", false),
            "{pointer}"
        );
    }
    let mut missing = row.clone();
    missing[0]["Config"].as_object_mut().unwrap().remove("Cmd");
    assert!(!accepted(&original, &missing, "task-v2", false));
    assert!(!accepted(&original, &row, "task-v1", false));
    assert!(!accepted(&original, &row, "task-v2", true));
}
#[test]
fn native_launch_disables_tini_and_keeps_late_mounts_before_the_three_word_tail() {
    let corpus: Value =
        serde_json::from_str(include_str!("fixtures/worker_launch/create.json")).unwrap();
    let case = &corpus["cases"][0];
    let mut config: Value = serde_json::from_str(case["configuration"].as_str().unwrap()).unwrap();
    config["_taskPerfPolicy"] = json!("task-v2");
    let config = worker_config::decode(&serde_json::to_vec(&config).unwrap()).unwrap();
    let session = ProfileSessionId::parse(case["session"].as_str().unwrap()).unwrap();
    let text = MetadataText::from_scalar_text;
    let args = create_arguments(
        &config,
        &session,
        &text(case["home"].as_str().unwrap()),
        None,
        CreateObservations {
            security: &[],
            runtime: &[],
            gpu: &[],
            employee: None,
        },
    )
    .unwrap();
    let expanded = args.with_late_mounts(
        Some(&text("/fixture/nix")),
        &[text("--fixture-account-mount")],
    );
    let strings = expanded
        .iter()
        .map(|arg| arg.scalar_text().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        strings
            .iter()
            .filter(|word| **word == "--init=false")
            .count(),
        1
    );
    assert!(!strings.iter().any(|word| word == "--init"));
    let entrypoint = strings
        .iter()
        .position(|word| *word == "--entrypoint")
        .unwrap();
    assert_eq!(entrypoint, strings.len() - 3);
    assert_eq!(strings[entrypoint + 1], WORKER_INIT);
    assert_eq!(strings[entrypoint - 1], "--fixture-account-mount");
    assert_eq!(
        strings[entrypoint - 2],
        "type=bind,src=/fixture/nix,dst=/nix"
    );
    assert_eq!(strings[entrypoint - 3], "--mount");
}
