use super::*;
use crate::engine_metadata::{EngineBootstrap, EngineFault, EngineQuery};
use reverie_core::{
    resources::{BudgetMode, CpuQuota, ResourcePolicy},
    worker_schema::WorkerIds,
};
use std::{collections::BTreeMap, fs, time::Duration};
fn base(image: char, memory: u32) -> WorkerBase {
    WorkerBase::try_new(
        "fixture".into(),
        "fixture-server".into(),
        format!("sha256:{}", image.to_string().repeat(64)),
        WorkerIds::try_new(1000, 1000).unwrap(),
        4,
        ResourcePolicy::try_new(
            BudgetMode::Admission,
            memory,
            128,
            CpuQuota::from_integer(1).unwrap(),
            8192,
            512,
        )
        .unwrap(),
    )
    .unwrap()
}
#[test]
fn identity_keeps_immutable_fields_without_freezing_refreshed_image_or_resources() {
    let first = WorkerServiceIdentity::capture(&base('a', 1024));
    let refreshed = WorkerServiceIdentity::capture(&base('b', 2048));
    assert_eq!(first, refreshed);
    assert_eq!(first.connection_limit(), 8);
    assert_eq!(first.deployment(), "fixture");
    assert_eq!(first.container(), "fixture-server");
    assert_eq!(first.ids(), WorkerIds::try_new(1000, 1000).unwrap());
    assert_eq!(first.max_workers(), 4);
}
#[test]
fn runtime_uses_the_consumed_native_capture_and_its_actual_close_fence() {
    let program = crate::engine_metadata::tests::program();
    let bootstrap = EngineBootstrap::from_service(
        program.as_os_str(),
        BTreeMap::new(),
        fs::canonicalize(std::env::temp_dir()).unwrap(),
    )
    .unwrap();
    let installed = InstalledWorkerEngine::new(bootstrap);
    let original = installed.readonly();
    let runtime = WorkerRuntime::new(installed, &base('a', 1024));
    let reader = runtime.readonly();
    assert!(Arc::ptr_eq(&reader.client, &original.client));
    assert_eq!(runtime.connection_limit(), 8);
    let end = Instant::now() + Duration::from_secs(2);
    assert_eq!(
        reader
            .query(EngineQuery::InventoryIds, end, &CancellationToken::new())
            .unwrap(),
        "ps\0-aq\0--no-trunc"
    );
    let first = runtime.request_stop();
    assert_eq!(runtime.request_stop(), first);
    assert_eq!(runtime.stop_deadline(), Some(first));
    assert!(runtime.cancellation().is_cancelled());
    runtime.close(end).unwrap();
    assert_eq!(
        original
            .query(EngineQuery::InventoryIds, end, &CancellationToken::new())
            .unwrap_err()
            .fault(),
        EngineFault::Busy
    );
}
#[test]
fn stop_budget_is_live_readonly_same_engine_state_and_never_renews_first_stop() {
    let make = || {
        WorkerRuntime::new(
            InstalledWorkerEngine::new(
                EngineBootstrap::from_service(
                    crate::engine_metadata::tests::program().as_os_str(),
                    BTreeMap::new(),
                    fs::canonicalize(std::env::temp_dir()).unwrap(),
                )
                .unwrap(),
            ),
            &base('a', 1024),
        )
    };
    let runtime = make();
    let foreign = make();
    let budget = runtime.stop_budget();
    assert!(budget.same_origin(&runtime.stop_budget()));
    assert!(budget.same_runtime(&runtime));
    assert!(!budget.same_runtime(&foreign));
    assert!(!budget.same_origin(&foreign.stop_budget()));
    assert_eq!(budget.deadline(), None);
    let end = runtime.request_stop();
    assert_eq!(budget.deadline(), Some(end));
    assert_eq!(runtime.request_stop(), end);
    assert_eq!(budget.clone().deadline(), Some(end));
    runtime
        .close(Instant::now() + Duration::from_secs(2))
        .unwrap();
    assert_eq!(budget.deadline(), Some(end));
    foreign
        .close(Instant::now() + Duration::from_secs(2))
        .unwrap();
}
