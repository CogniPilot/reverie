use super::*;
use crate::{engine_metadata::EngineBootstrap, installed_worker_engine::InstalledWorkerEngine};
use reverie_contracts::{worker_config, worker_schema::WorkerEnvelope};
use serde_json::json;
use std::{
    cell::RefCell,
    collections::BTreeMap,
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
#[path = "tests_process.rs"]
mod process_cases;
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let root = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!(
                "reverie-observed-create-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        fs::create_dir(root.join("work")).unwrap();
        fs::write(root.join("company.json"), b"{\"employees\":[]}").unwrap();
        fs::set_permissions(root.join("company.json"), fs::Permissions::from_mode(0o600)).unwrap();
        Self(root)
    }
    fn source(&self) -> EffectiveWorkerConfig {
        let info = fs::metadata(&self.0).unwrap();
        worker_config::decode(&serde_json::to_vec(&json!({"version":1,"deployment":"demo","image":format!("sha256:{}","a".repeat(64)),"serverContainer":"demo","socket":"/run/launch-order.sock","stateRoot":self.0.join("state"),"companyFile":self.0.join("company.json"),"companyRoot":self.0.join("company"),"scratchRoot":self.0.join("scratch"),"apiSocketRoot":self.0.join("api"),"budgetMode":"pool","uid":info.uid(),"gid":info.gid(),"memoryMiB":0,"poolMemoryMiB":4096,"poolTasksMax":1024,"cgroupParent":"reverie-workers.slice","pidsLimit":128,"cpus":0,"maxWorkers":4,"mounts":[{"source":self.0.join("work"),"destination":"/workspace","readOnly":false}],"maintenanceSessions":[]})).unwrap()).unwrap()
    }
    fn runtime(&self) -> WorkerRuntime {
        let source = self.source();
        let envelope = WorkerEnvelope::capture(source.clone()).unwrap();
        let capture = EngineBootstrap::from_service(
            std::env::current_exe().unwrap().as_os_str(),
            BTreeMap::new(),
            self.0.clone(),
        )
        .unwrap();
        WorkerRuntime::new(InstalledWorkerEngine::new(capture), envelope.base())
    }
    fn controlled_runtime(&self) -> WorkerRuntime {
        let source = self.source();
        let envelope = WorkerEnvelope::capture(source).unwrap();
        let program = self.0.join("storage-writer");
        if !program.exists() {
            fs::hard_link(crate::engine_metadata::tests::program(), &program).unwrap();
        }
        let capture =
            EngineBootstrap::from_service(program.as_os_str(), BTreeMap::new(), self.0.clone())
                .unwrap();
        WorkerRuntime::new(InstalledWorkerEngine::new(capture), envelope.base())
    }
}

#[test]
fn sealed_existing_inspection_is_from_actual_fixed_query_and_rejects_other_runtime_or_plan_observation()
 {
    let tree = Tree::new();
    let runtime = tree.controlled_runtime();
    let other = tree.controlled_runtime();
    let source = tree.source();
    let storage = runtime
        .resolve_storage(&source, &sid())
        .unwrap()
        .into_legacy()
        .unwrap();
    let plan = runtime
        .prepare_laptop_plan(source.clone(), source.clone(), &storage)
        .unwrap();
    let second = runtime
        .prepare_laptop_plan(source.clone(), source, &storage)
        .unwrap();
    fs::write(tree.0.join("inspect.out"), serde_json::to_vec(&json!([{"Config":{"Labels":{"reverie.worker":"demo","reverie.session":sid().as_str()}},"State":{"Running":false}},42])).unwrap()).unwrap();
    assert!(matches!(
        plan.inspect_existing(&other, end()),
        Err(ExistingObservationError::Origin)
    ));
    assert!(
        !tree.0.join("calls.txt").exists(),
        "wrong runtime refused before native constructor"
    );
    let observed = plan.inspect_existing(&runtime, end()).unwrap().unwrap();
    observed.assert_plan(&runtime, &plan).unwrap();
    assert!(observed.assert_plan(&runtime, &second).is_err());
    assert!(observed.assert_plan(&other, &plan).is_err());
    assert!(!observed.data().running().unwrap());
    let calls = fs::read_to_string(tree.0.join("calls.txt")).unwrap();
    assert_eq!(calls, format!("inspect\0demo-agent-{}\n", sid().as_str()));
    storage.close(end()).unwrap();
    runtime.close(end()).unwrap();
    other.close(end()).unwrap();
}

#[test]
fn sealed_existing_optional_nonzero_ignores_unparseable_stdout_without_changing_same_client_policy()
{
    let tree = Tree::new();
    let runtime = tree.controlled_runtime();
    let source = tree.source();
    let storage = runtime
        .resolve_storage(&source, &sid())
        .unwrap()
        .into_legacy()
        .unwrap();
    let plan = runtime
        .prepare_laptop_plan(source.clone(), source, &storage)
        .unwrap();
    fs::write(tree.0.join("inspect.out"), b"not JSON").unwrap();
    fs::write(tree.0.join("inspect.out.status"), b"7").unwrap();
    assert!(plan.inspect_existing(&runtime, end()).unwrap().is_none());
    storage.close(end()).unwrap();
    runtime.close(end()).unwrap();
}
impl Drop for Tree {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn sid() -> ProfileSessionId {
    ProfileSessionId::parse("00000000-0000-0000-0000-000000000000").unwrap()
}
fn end() -> Instant {
    Instant::now() + Duration::from_secs(2)
}
struct Observed {
    log: RefCell<Vec<&'static str>>,
    fail: usize,
}
impl Source for Observed {
    fn rootless(&self, config: &RootlessConfig) -> Result<rootless::RootlessObservation> {
        self.log.borrow_mut().push("rootless");
        if self.log.borrow().len() == self.fail {
            return Err(CreateObservationError::Rootless(
                rootless::RootlessHostError::OwnerMismatch,
            ));
        }
        Ok(rootless::observe_rootless(config)?)
    }
    fn gpu(
        &self,
        config: &EffectiveWorkerConfig,
        session: &ProfileSessionId,
    ) -> Result<Vec<String>> {
        self.log.borrow_mut().push("gpu");
        gpu_arguments(config, session)
    }
    fn hostname(
        &self,
        config: &EffectiveWorkerConfig,
        storage: &StoragePaths,
    ) -> Result<Option<String>> {
        self.log.borrow_mut().push("hostname");
        Ok(super::super::employee_hostname(config, storage)?)
    }
}
#[test]
fn security_and_runtime_are_separate_actual_observations_before_late_metadata() {
    let tree = Tree::new();
    let runtime = tree.runtime();
    let source = tree.source();
    let storage = runtime
        .resolve_storage(&source, &sid())
        .unwrap()
        .into_legacy()
        .unwrap();
    for fail in [1, 2, 99] {
        let observed = Observed {
            log: RefCell::new(Vec::new()),
            fail,
        };
        let result = observe_with(&source, &sid(), storage.paths(), &observed);
        if fail == 99 {
            assert!(result.is_ok());
            assert_eq!(
                &*observed.log.borrow(),
                &["rootless", "rootless", "gpu", "hostname"]
            );
        } else {
            assert!(matches!(result, Err(CreateObservationError::Rootless(_))));
            assert_eq!(observed.log.borrow().len(), fail);
        }
    }
    storage.close(end()).unwrap();
    runtime.close(end()).unwrap();
}
#[test]
fn actual_observed_plan_is_same_runtime_bound_and_keeps_image_mutable() {
    let tree = Tree::new();
    let runtime = tree.runtime();
    let other = tree.runtime();
    let source = tree.source();
    let storage = runtime
        .resolve_storage(&source, &sid())
        .unwrap()
        .into_legacy()
        .unwrap();
    let before = runtime
        .prepare_laptop_plan(source.clone(), source.clone(), &storage)
        .unwrap();
    let mut raw: serde_json::Value =
        serde_json::from_slice(&worker_config::encode_config(&source)).unwrap();
    raw["image"] = json!(format!("sha256:{}", "b".repeat(64)));
    let updated = worker_config::decode(&serde_json::to_vec(&raw).unwrap()).unwrap();
    let after = runtime
        .prepare_laptop_plan(updated.clone(), updated, &storage)
        .unwrap();
    let same = before.same_runtime(&runtime) && after.same_runtime(&runtime);
    let other_rejected = other
        .prepare_laptop_plan(source.clone(), source, &storage)
        .err()
        .unwrap();
    storage.close(end()).unwrap();
    runtime.close(end()).unwrap();
    other.close(end()).unwrap();
    assert!(same && !before.same_runtime(&other));
    assert!(matches!(other_rejected, CreateObservationError::Owner(_)));
    assert_ne!(
        before.arguments().config_digest(),
        after.arguments().config_digest()
    );
    assert_eq!(
        before.arguments().policy_digest(),
        after.arguments().policy_digest()
    );
    assert_eq!(before.storage(), after.storage());
}
