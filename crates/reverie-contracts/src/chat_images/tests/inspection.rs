use super::*;
use crate::storage_identity::MetadataText;
use reverie_core::{
    PythonText,
    ids::ProfileSessionId,
    resources::{BudgetMode, CpuQuota, ResourcePolicy},
    worker_laptop::WorkerContainerName,
    worker_schema::{WorkerBase, WorkerIds},
};
fn base(ids: WorkerIds) -> WorkerBase {
    WorkerBase::try_new(
        "fixture".into(),
        "fixture-server".into(),
        format!("sha256:{}", "a".repeat(64)),
        ids,
        4,
        ResourcePolicy::try_new(
            BudgetMode::Admission,
            1024,
            128,
            CpuQuota::from_integer(1).unwrap(),
            8192,
            512,
        )
        .unwrap(),
    )
    .unwrap()
}
fn pair(row: &Json, key: &str) -> [u64; 2] {
    [row[key][0].as_u64().unwrap(), row[key][1].as_u64().unwrap()]
}
#[test]
fn actual_original_python_binding_projections_preserve_full_mounts_unicode_and_big_generation() {
    let fixture: Json = serde_json::from_str(include_str!(
        "../../../tests/fixtures/chat-image-bindings-python.json"
    ))
    .unwrap();
    for row in fixture["rows"].as_array().unwrap() {
        let session = ProfileSessionId::parse(row["session"].as_str().unwrap()).unwrap();
        let ids = WorkerIds::try_new(
            row["uid"].as_u64().unwrap() as u32,
            row["gid"].as_u64().unwrap() as u32,
        )
        .unwrap();
        let name = WorkerContainerName::for_session(&base(ids), &session);
        let parsed = decode_inspection(
            row["inspection"].as_str().unwrap(),
            &name,
            "fixture",
            &session,
            row["employee"].as_str().unwrap(),
            ids,
        )
        .unwrap();
        let owner = Some(MetadataText::from_python_text(
            PythonText::try_new(
                row["ownerPoints"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|cp| cp.as_u64().unwrap() as u32)
                    .collect(),
            )
            .unwrap(),
        ));
        let root = MetadataText::from_scalar_text(row["root"].as_str().unwrap());
        let generation = UnsignedInteger::parse(row["generation"].as_str().unwrap()).unwrap();
        let digest = parsed.projection(
            ImageStorageProjection {
                session: &session,
                employee: row["employee"].as_str().unwrap(),
                owner: &owner,
                root: &root,
            },
            ImageNamespaceProjection {
                start: "12345",
                generation: &generation,
                temporary: pair(row, "temporary"),
                office: pair(row, "office"),
            },
        );
        assert_eq!(
            digest.as_str(),
            row["expected"].as_str().unwrap(),
            "{}",
            row["label"]
        );
    }
}
#[test]
fn native_state_requires_exact_boolean_running_and_explicit_negative_flags() {
    let fixture: Json = serde_json::from_str(include_str!(
        "../../../tests/fixtures/chat-image-bindings-python.json"
    ))
    .unwrap();
    let row = &fixture["rows"][0];
    let session = ProfileSessionId::parse(row["session"].as_str().unwrap()).unwrap();
    let ids = WorkerIds::try_new(
        row["uid"].as_u64().unwrap() as u32,
        row["gid"].as_u64().unwrap() as u32,
    )
    .unwrap();
    let name = WorkerContainerName::for_session(&base(ids), &session);
    for (flag, value) in [
        ("Running", json!(1)),
        ("Paused", json!(true)),
        ("Restarting", json!(true)),
        ("Dead", json!(true)),
        ("Pid", json!(true)),
    ] {
        let mut wrong: Json = serde_json::from_str(row["inspection"].as_str().unwrap()).unwrap();
        wrong[0]["State"][flag] = value;
        assert!(
            decode_inspection(
                &serde_json::to_string(&wrong).unwrap(),
                &name,
                "fixture",
                &session,
                row["employee"].as_str().unwrap(),
                ids
            )
            .is_err()
        );
    }
}
