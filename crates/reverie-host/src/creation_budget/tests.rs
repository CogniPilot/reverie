use super::*;
use crate::{
    engine_metadata::{CancellationToken, EngineBootstrap, EngineFault, EngineQuery},
    installed_worker_engine::InstalledWorkerEngine,
};
use reverie_contracts::creation_budget::CreationPeerNames;
use reverie_core::{
    resources::{BudgetMode, CpuQuota, ResourcePolicy},
    worker_schema::{WorkerBase, WorkerIds},
};
use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "creation-host-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn bootstrap(&self, mode: &str) -> EngineBootstrap {
        let executable = self.0.join(mode);
        fs::hard_link(crate::engine_metadata::tests::program(), &executable).unwrap();
        EngineBootstrap::from_service(executable.as_os_str(), BTreeMap::new(), self.0.clone())
            .unwrap()
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn base() -> WorkerBase {
    WorkerBase::try_new(
        "test".into(),
        "test-console".into(),
        format!("sha256:{}", "a".repeat(64)),
        WorkerIds::try_new(1000, 1000).unwrap(),
        4,
        ResourcePolicy::try_new(
            BudgetMode::Admission,
            512,
            128,
            CpuQuota::from_integer(0).unwrap(),
            4096,
            1024,
        )
        .unwrap(),
    )
    .unwrap()
}
fn end() -> Instant {
    Instant::now() + Duration::from_secs(3)
}
#[test]
fn actual_creation_queries_keep_fixed_argv_same_context_and_permanent_close() {
    let tree = Tree::new();
    let bootstrap = tree.bootstrap("argv");
    let starts = bootstrap.hooks.starts.clone();
    let installed = InstalledWorkerEngine::new(bootstrap);
    let prior = installed.readonly();
    let runtime = WorkerRuntime::new(installed, &base());
    assert!(Arc::ptr_eq(&prior.client, &runtime.readonly().client));
    assert_eq!(
        runtime.creation_peer_names(end()).unwrap(),
        "ps\0--filter\0label=reverie.worker=test\0--format\0{{.Names}}"
    );
    let names = CreationPeerNames::capture(
        "test-agent-00000000-0000-0000-0000-000000000000",
        [],
        "test",
    );
    let name = names.names().next().unwrap();
    let output = runtime.inspect_creation_peer(&name, end()).unwrap();
    assert!(output.succeeded);
    assert_eq!(
        output.stdout,
        b"inspect\0test-agent-00000000-0000-0000-0000-000000000000"
    );
    assert_eq!(starts.load(Ordering::SeqCst), 2);
    let foreign = CreationPeerNames::capture(name.name(), [], "foreign");
    assert!(matches!(
        runtime.inspect_creation_peer(&foreign.names().next().unwrap(), end()),
        Err(CreationHostError::Namespace)
    ));
    assert_eq!(starts.load(Ordering::SeqCst), 2);
    runtime.close(end()).unwrap();
    assert!(
        matches!(runtime.creation_peer_names(end()),Err(CreationHostError::Engine(ref error)) if error.fault()==EngineFault::Cancelled)
    );
    assert_eq!(
        prior
            .query(EngineQuery::InventoryIds, end(), &CancellationToken::new())
            .unwrap_err()
            .fault(),
        EngineFault::Busy
    );
    assert_eq!(starts.load(Ordering::SeqCst), 2);
}
#[test]
fn actual_optional_inspect_preserves_nonzero_but_running_census_requires_success() {
    let tree = Tree::new();
    let runtime = WorkerRuntime::new(
        InstalledWorkerEngine::new(tree.bootstrap("failure")),
        &base(),
    );
    let names = CreationPeerNames::capture("11111111-2222-4333-8444-555555555555", [], "test");
    assert!(
        !runtime
            .inspect_creation_peer(&names.names().next().unwrap(), end())
            .unwrap()
            .succeeded
    );
    let error = runtime.creation_peer_names(end()).unwrap_err();
    assert!(
        matches!(error,CreationHostError::Engine(ref error) if error.fault()==EngineFault::Exit)
    );
    assert!(!error.to_string().contains("synthetic-private-diagnostic"));
    runtime.close(end()).unwrap();
}
#[test]
fn actual_creation_query_uses_shared_four_mib_output_policy() {
    let tree = Tree::new();
    let runtime = WorkerRuntime::new(InstalledWorkerEngine::new(tree.bootstrap("dual8")), &base());
    assert!(
        matches!(runtime.creation_peer_names(end()),Err(CreationHostError::Engine(ref error)) if error.fault()==EngineFault::OutputBound)
    );
    runtime.settle_owned(end()).unwrap();
    runtime.close(end()).unwrap();
}
