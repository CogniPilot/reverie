//! Retained actual plan selection survives a later current-source change.
use super::*;

#[test]
fn selected_retained_plan_cannot_create_after_current_selection_is_removed() {
    if crate::test_process::isolate_case(concat!(
        "worker_laptop::tests::create::provider::",
        "selected_retained_plan_cannot_create_after_current_selection_is_removed"
    )) {
        return;
    }
    let mut fixture = Fixture::new("created-normal");
    let legacy = fixture.source.clone();
    let mut source: serde_json::Value =
        serde_json::from_slice(&worker_config::encode_config(&legacy)).unwrap();
    let policy = json!({"version":1,"purpose":"reverie-docker-worker-pool-v1",
        "deployment":"fixture","instanceRoot":"/home/fixture/reverie",
        "engineId":"11111111-1111-4111-8111-111111111111",
        "anchorImage":format!("sha256:{}","a".repeat(64)),
        "controllerImage":format!("sha256:{}","c".repeat(64)),
        "websiteContainer":"b".repeat(64),"brokerUid":1000,"brokerGid":100,
        "memoryMaxMiB":49152,"poolTasksMax":8192,"cpuWeight":100,"allowedCpus":[0,1],
        "employeeMemoryHighMiB":{"11111111-2222-4333-8444-555555555555":1024}});
    let policy_data = reverie_contracts::worker_pool::WorkerPoolPolicy::decode(
        &serde_json::to_vec(&policy).unwrap(),
    )
    .unwrap();
    source["cgroupParent"] = json!(policy_data.parent_slice());
    source["workerPoolProvider"] = json!({"version":1,
        "purpose":"reverie-docker-worker-pool-provider-v1","policy":policy});
    fixture.source = worker_config::decode(&serde_json::to_vec(&source).unwrap()).unwrap();
    let workflow = fixture.retain();
    fixture
        .runtime()
        .run_laptop_network(&workflow, end())
        .unwrap();
    // The real retained Nix/plan/request/phone remain unchanged. Only the
    // current source supplied by this fixture has reverted to legacy.
    fixture.source = legacy;
    let telemetry = CommandTelemetry::capture(fixture.runtime(), &fixture.source).unwrap();
    let result = fixture
        .runtime()
        .create_laptop(&workflow, &telemetry, end());
    let untouched = {
        let record = workflow.record.lock().unwrap();
        record.phase == Phase::Known && record.creation.is_none() && !record.unknown
    };
    let calls = creates(&fixture);
    let created = fixture.root.join("created-laptop").exists();
    // Always settle the actual fixed child and close the real Office before
    // the verdict, including an unexpected successful baseline. These are
    // component finalizers; the retained workflow is no capacity/release ACK.
    let native = fixture.runtime().installed_engine().settle_owned(end());
    let office = fixture.office.close(end());
    assert!(native.is_ok(), "actual native child cleanup: {native:?}");
    assert!(office.is_ok(), "actual Office cleanup: {office:?}");
    assert!(matches!(
        result,
        Err(LaptopError::Refused(
            "WORKER_POOL_PROVIDER_MAINTENANCE_REQUIRED"
        ))
    ));
    assert!(untouched, "refusal precedes the one-shot creation phase");
    assert_eq!(calls, 0);
    assert!(!created);
}
