use super::*;
use reverie_contracts::worker_config::{self, EffectiveWorkerConfig};
use reverie_core::{
    resources::{BudgetMode, CpuQuota, ResourcePolicy},
    worker_schema::{WorkerBase, WorkerIds},
};
use reverie_host::{
    engine_metadata::EngineBootstrap, installed_worker_engine::InstalledWorkerEngine,
    worker_storage::StorageLease,
};
use serde_json::json;
use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::PathBuf,
    sync::atomic::{AtomicUsize, Ordering},
};
const SID: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const NEXT_SID: &str = "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const EID: &str = "11111111-2222-4333-8444-555555555555";
static NEXT: AtomicUsize = AtomicUsize::new(0);
type BeforeLock = Box<dyn FnOnce()>;
thread_local! {static BEFORE_BLOCKING_LOCK:std::cell::RefCell<Option<BeforeLock>>=std::cell::RefCell::new(None);}
pub(in crate::installing_broker) fn observe_next_blocking_lock(hook: impl FnOnce() + 'static) {
    BEFORE_BLOCKING_LOCK.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
}
pub(super) fn before_blocking_lock() {
    BEFORE_BLOCKING_LOCK.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
}
fn sid(value: &str) -> ProfileSessionId {
    ProfileSessionId::parse(value).unwrap()
}
fn end() -> Instant {
    Instant::now() + Duration::from_secs(2)
}
use crate::test_process::engine_program as program;
use crate::test_process::isolate_case as isolate;
#[path = "cold_tests.rs"]
mod cold_cases;
#[path = "direct_finalization/tests.rs"]
mod direct_finalization_cases;
#[path = "nix/network/tests.rs"]
mod network_cases;
#[path = "nix/tests.rs"]
mod nix_cases;
#[path = "replacement_stop/tests.rs"]
mod replacement_stop_cases;
#[path = "stopped_ram/tests.rs"]
mod stopped_ram_cases;
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let root = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!(
                "reverie-storage-registry-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let tree = Self(root);
        tree.company(SID, EID);
        tree.write("ps.out", b"");
        tree.write("inspect.out", b"[]");
        tree
    }
    fn write(&self, name: &str, bytes: &[u8]) {
        let path = self.0.join(name);
        fs::write(&path, bytes).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    fn company(&self, session: &str, employee: &str) {
        self.write("company.json",serde_json::to_vec(&json!({"employees":[{"id":employee,"owner":null,"sessionId":session,"desiredRunning":true}]})).unwrap().as_slice());
    }
    fn source(&self) -> EffectiveWorkerConfig {
        worker_config::decode(&serde_json::to_vec(&json!({"uid":fs::metadata(&self.0).unwrap().uid(),"gid":fs::metadata(&self.0).unwrap().gid(),"deployment":"fixture","serverContainer":"fixture-server","maxWorkers":4,"companyFile":self.0.join("company.json"),"stateRoot":self.0.join("state"),"scratchRoot":self.0.join("scratch"),"mounts":[],"image":format!("sha256:{}","a".repeat(64))})).unwrap()).unwrap()
    }
    fn registry(&self) -> Arc<StorageRegistry> {
        self.registry_with(program(), BTreeMap::new())
    }
    fn registry_with(
        &self,
        executable: &std::path::Path,
        environment: BTreeMap<std::ffi::OsString, std::ffi::OsString>,
    ) -> Arc<StorageRegistry> {
        let uid = fs::metadata(&self.0).unwrap().uid();
        let gid = fs::metadata(&self.0).unwrap().gid();
        let base = WorkerBase::try_new(
            "fixture".into(),
            "fixture-server".into(),
            format!("sha256:{}", "a".repeat(64)),
            WorkerIds::try_new(uid, gid).unwrap(),
            4,
            ResourcePolicy::try_new(
                BudgetMode::Pool,
                0,
                128,
                CpuQuota::from_integer(0).unwrap(),
                4096,
                1024,
            )
            .unwrap(),
        )
        .unwrap();
        let bootstrap =
            EngineBootstrap::from_service(executable.as_os_str(), environment, self.0.clone())
                .unwrap();
        Arc::new(StorageRegistry::new(WorkerRuntime::new(
            InstalledWorkerEngine::new(bootstrap),
            &base,
        )))
    }
    fn calls(&self) -> usize {
        fs::read_to_string(self.0.join("calls.txt")).map_or(0, |text| text.lines().count())
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn legacy_claim_bypasses_held_registry_mutex_and_never_runs_engine_or_invents_lock_tree() {
    let tree = Tree::new();
    let registry = tree.registry();
    let held = registry.entries.lock().unwrap();
    let claim = registry
        .claim(&tree.source(), &sid("00000000-0000-0000-0000-000000000000"))
        .unwrap();
    assert!(!claim.newly_claimed());
    assert_eq!(claim.paths().kind(), StorageKind::Session);
    assert!(!tree.0.join("state").exists());
    assert_eq!(tree.calls(), 0);
    assert!(held.is_empty());
    claim.release(end()).unwrap();
    drop(held);
    registry.runtime.close(end()).unwrap();
}
#[test]
fn actual_claim_registry_retains_lifetime_after_handle_drop_and_reuses_exact_previous_binding() {
    if isolate(
        "installing_broker::storage::tests::actual_claim_registry_retains_lifetime_after_handle_drop_and_reuses_exact_previous_binding",
    ) {
        return;
    }
    let tree = Tree::new();
    let registry = tree.registry();
    let source = tree.source();
    let claim = registry.claim(&source, &sid(SID)).unwrap();
    assert!(claim.newly_claimed());
    assert_eq!(registry.entries.lock().unwrap().len(), 1);
    drop(claim);
    assert!(StorageLease::acquire_launch(&source, &sid(SID)).is_err());
    let previous = registry.claim(&source, &sid(SID)).unwrap();
    assert!(!previous.newly_claimed());
    assert_eq!(tree.calls(), 2);
    previous.release(end()).unwrap();
    assert!(registry.entries.lock().unwrap().is_empty());
    StorageLease::acquire_launch(&source, &sid(SID))
        .unwrap()
        .close()
        .unwrap();
    registry.runtime.close(end()).unwrap();
}
#[test]
fn changed_same_session_binding_and_previous_employee_identity_refuse_before_second_census() {
    if isolate(
        "installing_broker::storage::tests::changed_same_session_binding_and_previous_employee_identity_refuse_before_second_census",
    ) {
        return;
    }
    let tree = Tree::new();
    let registry = tree.registry();
    let source = tree.source();
    let claim = registry.claim(&source, &sid(SID)).unwrap();
    tree.company(SID, "22222222-2222-4333-8444-555555555555");
    assert_eq!(
        registry.claim(&source, &sid(SID)).err().unwrap().code(),
        "WORKER_EMPLOYEE_BINDING_CHANGED"
    );
    tree.company(NEXT_SID, EID);
    assert_eq!(
        registry
            .claim(&source, &sid(NEXT_SID))
            .err()
            .unwrap()
            .code(),
        "WORKER_PREVIOUS_EMPLOYEE_STORAGE_BUSY"
    );
    assert_eq!(tree.calls(), 1);
    claim.release(end()).unwrap();
    registry.runtime.close(end()).unwrap();
}
#[test]
fn refused_writer_inventory_never_registers_a_positive_claim_and_keeps_original_error() {
    if isolate(
        "installing_broker::storage::tests::refused_writer_inventory_never_registers_a_positive_claim_and_keeps_original_error",
    ) {
        return;
    }
    let tree = Tree::new();
    let registry = tree.registry();
    let source = tree.source();
    tree.write("ps.out", b"invalid-id\n");
    assert_eq!(
        registry.claim(&source, &sid(SID)).err().unwrap().code(),
        "WORKER_STORAGE_WRITER_IDS"
    );
    assert!(registry.entries.lock().unwrap().is_empty());
    StorageLease::acquire_launch(&source, &sid(SID))
        .unwrap()
        .close()
        .unwrap();
    registry.runtime.close(end()).unwrap();
}
#[test]
fn bounded_lock_wait_preserves_real_registered_owner_on_expired_release_budget() {
    let tree = Tree::new();
    let registry = tree.registry();
    let claim = registry.claim(&tree.source(), &sid(SID)).unwrap();
    let held = registry.entries.lock().unwrap();
    assert_eq!(
        registry.lock(Some(Instant::now())).err().unwrap().code(),
        "STORAGE_LOCK_UNAVAILABLE"
    );
    assert_eq!(held.len(), 1);
    drop(held);
    claim.release(end()).unwrap();
    registry.runtime.close(end()).unwrap();
}

#[test]
fn stop_arriving_after_unbounded_release_capture_keeps_the_real_owner_and_waiting_task() {
    if isolate(
        "installing_broker::storage::tests::stop_arriving_after_unbounded_release_capture_keeps_the_real_owner_and_waiting_task",
    ) {
        return;
    }
    let tree = Tree::new();
    let registry = tree.registry();
    let source = tree.source();
    let claim = registry.claim(&source, &sid(SID)).unwrap();
    let held = registry.entries.lock().unwrap();
    let (captured, receive) = std::sync::mpsc::channel();
    let release = std::thread::spawn(move || {
        BEFORE_BLOCKING_LOCK
            .with(|slot| *slot.borrow_mut() = Some(Box::new(move || captured.send(()).unwrap())));
        claim.release(end())
    });
    receive.recv_timeout(Duration::from_secs(2)).unwrap();
    // The real release has selected the source's None-deadline Mutex::lock
    // branch. This thread still holds that exact mutex; no new stop/deadline
    // selection is permitted to turn this in-flight owner into completion.
    std::thread::sleep(Duration::from_millis(20));
    assert!(!release.is_finished());
    let stop = registry.runtime.request_stop();
    assert_eq!(registry.runtime.stop_deadline(), Some(stop));
    assert_eq!(registry.runtime.request_stop(), stop);
    assert!(!release.is_finished());
    assert_eq!(held.len(), 1);
    assert!(StorageLease::acquire_launch(&source, &sid(SID)).is_err());
    std::thread::sleep(Duration::from_millis(20));
    assert!(!release.is_finished());
    drop(held);
    release.join().unwrap().unwrap();
    assert!(registry.entries.lock().unwrap().is_empty());
    registry.runtime.close(end()).unwrap();
}
#[test]
fn actual_installing_bootstrap_consumes_runtime_and_uses_real_wait_binding_reader() {
    let tree = crate::reservation_gate::tests::Tree::new();
    tree.write(
        "company.json",
        serde_json::to_vec(&json!({"employees":[{"id":EID,"owner":null,"sessionId":SID}]}))
            .unwrap()
            .as_slice(),
    );
    tree.write("ps.out", b"");
    let snapshot =
        crate::worker_validation::load_owner_config(&tree.root.join("worker.json")).unwrap();
    let bootstrap =
        EngineBootstrap::from_service(program().as_os_str(), BTreeMap::new(), tree.root.clone())
            .unwrap();
    let runtime = WorkerRuntime::new(
        InstalledWorkerEngine::new(bootstrap),
        snapshot.envelope().base(),
    );
    let broker = InstallingBroker::new(snapshot, runtime).unwrap();
    assert!(broker.launch_wait_binding(&sid(SID)).unwrap().is_some());
    let claim = broker.claim_storage(&sid(SID)).unwrap();
    assert!(claim.newly_claimed());
    claim.release(end()).unwrap();
    broker.storage.runtime.close(end()).unwrap();
}
