//! Actual registry/lease and original process owner, with a fixed Rust engine.
//! This component fixture does not stand in for whole-J admission or Docker.
use super::*;
use crate::installing_broker::storage::replacement_stop::ReplacementStopPreparation;
use reverie_host::worker_launch::{ExistingProcessIncarnation, ObservedCreatePlan};
use std::{
    path::Path,
    process::{Command, Stdio},
    sync::OnceLock,
    thread::JoinHandle,
};
fn stop_program() -> &'static Path {
    static PROGRAM: OnceLock<PathBuf> = OnceLock::new();
    PROGRAM.get_or_init(|| {
        let root = std::env::temp_dir().join(format!("app-stop-build-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        let source = root.join("child.rs");
        fs::write(
            &source,
            include_str!("../../../../../reverie-host/tests/support/source_stop_child.rs"),
        )
        .unwrap();
        let binary = root.join("child");
        assert!(
            Command::new("rustc")
                .arg("--edition=2024")
                .arg(&source)
                .arg("-o")
                .arg(&binary)
                .status()
                .unwrap()
                .success()
        );
        binary
    })
}
struct Target {
    root: PathBuf,
    reaper: Option<JoinHandle<()>>,
    pid: u32,
}
impl Target {
    fn new(tree: &Tree) -> Self {
        let mut child = Command::new(stop_program())
            .arg("target")
            .env("SOURCE_EXIT_ON", "stop-requested")
            .current_dir(&tree.0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        let root = tree.0.clone();
        let reaper = std::thread::spawn(move || {
            assert!(child.wait().unwrap().success());
            fs::write(root.join("source-reaped"), b"exact target reaped").unwrap();
        });
        wait(tree, "source-ready");
        Self {
            root: tree.0.clone(),
            reaper: Some(reaper),
            pid,
        }
    }
}
impl Drop for Target {
    fn drop(&mut self) {
        fs::write(self.root.join("release-source"), b"owning fixture teardown").unwrap();
        if let Some(reaper) = self.reaper.take() {
            reaper.join().unwrap();
        }
    }
}
fn wait(tree: &Tree, leaf: &str) {
    let end = Instant::now() + Duration::from_secs(5);
    while !tree.0.join(leaf).exists() {
        assert!(Instant::now() < end, "owned fixture barrier {leaf}");
        std::thread::sleep(Duration::from_millis(1));
    }
}
fn source(tree: &Tree) -> EffectiveWorkerConfig {
    let mut raw: serde_json::Value =
        serde_json::from_slice(&worker_config::encode_config(&tree.source())).unwrap();
    for (name, value) in [
        ("memoryMiB", json!(0)),
        ("pidsLimit", json!(128)),
        ("cpus", json!(0)),
        ("budgetMode", json!("pool")),
        ("poolMemoryMiB", json!(4096)),
        ("poolTasksMax", json!(1024)),
        ("apiSocketRoot", json!(tree.0.join("office"))),
        ("companyRoot", json!(tree.0.join("company"))),
        ("cgroupParent", json!("reverie-workers.slice")),
    ] {
        raw[name] = value;
    }
    worker_config::decode(&serde_json::to_vec(&raw).unwrap()).unwrap()
}
fn registry(tree: &Tree, target: &Target, session: &str) -> Arc<StorageRegistry> {
    let source = source(tree);
    tree.write("registry-empty-census", b"controlled metadata only");
    tree.write("cid", "a".repeat(64).as_bytes());
    tree.write("name", format!("fixture-agent-{session}").as_bytes());
    let row = json!({"Id":"a".repeat(64),"Name":format!("/fixture-agent-{session}"),"Image":format!("sha256:{}","a".repeat(64)),"Config":{"Labels":{"reverie.worker":"fixture","reverie.session":session,"reverie.worker-policy":worker_config::policy_digest(&source).to_hex()}},"HostConfig":{},"Mounts":[],"State":{"Running":true,"Pid":target.pid}});
    tree.write("before.json", &serde_json::to_vec(&json!([row])).unwrap());
    let mut stopped = row;
    stopped["State"] = json!({"Running":false,"Pid":0});
    tree.write(
        "after.json",
        &serde_json::to_vec(&json!([stopped])).unwrap(),
    );
    tree.registry_with(
        stop_program(),
        BTreeMap::from([("SOURCE_EXIT_ON".into(), "stop-requested".into())]),
    )
}
fn inputs(
    registry: &Arc<StorageRegistry>,
    source: &EffectiveWorkerConfig,
    session: &str,
) -> (StorageClaim, ObservedCreatePlan, ExistingProcessIncarnation) {
    let mut claim = registry.claim(source, &sid(session)).unwrap();
    claim.prepare_cold_launch_storage().unwrap();
    claim.prepare_runtime_directory().unwrap();
    let plan = plan(&claim, source);
    let observed = plan
        .inspect_existing(&registry.runtime, end())
        .unwrap()
        .unwrap();
    let process = observed
        .capture_running_replacement_process(&registry.runtime, &plan, end())
        .unwrap();
    (claim, plan, process)
}
fn plan(claim: &StorageClaim, source: &EffectiveWorkerConfig) -> ObservedCreatePlan {
    match &claim.state {
        ClaimState::Legacy { registry, owner } => registry
            .runtime
            .prepare_laptop_plan(source.clone(), source.clone(), owner)
            .unwrap(),
        ClaimState::Registered {
            registry, identity, ..
        } => {
            let entries = registry.entries.lock().unwrap();
            let entry = entries
                .iter()
                .find(|entry| Arc::ptr_eq(&entry.identity, identity))
                .unwrap();
            let EntryOwner::Direct(owner) = &entry.owner else {
                panic!("actual direct input")
            };
            registry
                .runtime
                .prepare_laptop_plan(source.clone(), source.clone(), owner)
                .unwrap()
        }
    }
}
fn address(registry: &StorageRegistry) -> *const LaunchStorage {
    let entries = registry.entries.lock().unwrap();
    let EntryOwner::Direct(owner) = &entries[0].owner else {
        panic!("actual direct resource")
    };
    std::ptr::from_ref(owner.as_ref())
}
fn finish_with_source(
    preparation: ReplacementStopPreparation,
    source: &EffectiveWorkerConfig,
) -> StorageClaim {
    preparation.inspect().unwrap();
    preparation
        .stop_after_policy(&worker_config::policy_digest(source))
        .unwrap();
    preparation.reclaim(end()).unwrap().into_parts().0
}
#[test]
fn actual_registered_stop_restores_same_box_and_claim_generation_without_lease_release() {
    crate::test_process::owning_case!(
        actual_registered_stop_restores_same_box_and_claim_generation_without_lease_release
    );
    let tree = Tree::new();
    let target = Target::new(&tree);
    let registry = registry(&tree, &target, SID);
    let source = source(&tree);
    let (claim, plan, process) = inputs(&registry, &source, SID);
    let original = address(&registry);
    let ClaimState::Registered { identity, .. } = &claim.state else {
        panic!("actual registered")
    };
    let identity = identity.clone();
    let preparation = claim
        .retain_replacement_stop(plan, process, Some(Instant::now() + Duration::from_secs(5)))
        .unwrap();
    assert_eq!(registry.entries.lock().unwrap().len(), 1);
    assert!(registry.release(&identity, end()).is_err());
    assert!(StorageLease::acquire_launch(&source, &sid(SID)).is_err());
    let claim = finish_with_source(preparation, &source);
    assert!(tree.0.join("source-reaped").exists());
    assert_eq!(address(&registry), original);
    assert!(claim.newly_claimed());
    let ClaimState::Registered {
        identity: returned, ..
    } = &claim.state
    else {
        panic!("registered return")
    };
    assert!(Arc::ptr_eq(&identity, returned));
    assert!(StorageLease::acquire_launch(&source, &sid(SID)).is_err());
    claim.release(end()).unwrap();
    assert!(registry.entries.lock().unwrap().is_empty());
    registry.runtime.close(end()).unwrap();
}
#[test]
fn foreign_observation_generation_returns_all_original_inputs_and_keeps_entry_direct() {
    crate::test_process::owning_case!(
        foreign_observation_generation_returns_all_original_inputs_and_keeps_entry_direct
    );
    let tree = Tree::new();
    let target = Target::new(&tree);
    let registry = registry(&tree, &target, SID);
    let source = source(&tree);
    let (claim, original_plan, process) = inputs(&registry, &source, SID);
    let original = address(&registry);
    let different = plan(&claim, &source);
    let before = fs::read(tree.0.join("trace")).unwrap();
    let failure = claim
        .retain_replacement_stop(different, process, None)
        .err()
        .unwrap();
    let (claim, _different, process, cause) = failure.into_parts();
    assert_eq!(cause.code(), "WORKER_ORDINARY_STOP_OBSERVATION");
    assert_eq!(address(&registry), original);
    assert_eq!(fs::read(tree.0.join("trace")).unwrap(), before);
    let preparation = claim
        .retain_replacement_stop(original_plan, process, None)
        .unwrap();
    finish_with_source(preparation, &source)
        .release(end())
        .unwrap();
    registry.runtime.close(end()).unwrap();
}
#[test]
fn actual_stop_native_io_leaves_registry_available_and_retains_exact_busy_record() {
    crate::test_process::owning_case!(
        actual_stop_native_io_leaves_registry_available_and_retains_exact_busy_record
    );
    let tree = Tree::new();
    let target = Target::new(&tree);
    let registry = registry(&tree, &target, SID);
    let source = source(&tree);
    let (claim, plan, process) = inputs(&registry, &source, SID);
    let preparation = Arc::new(
        claim
            .retain_replacement_stop(plan, process, Some(Instant::now() + Duration::from_secs(5)))
            .unwrap(),
    );
    tree.write("hold-inspect-reply", b"own fixed barrier");
    let other = preparation.clone();
    let query = std::thread::spawn(move || other.inspect());
    wait(&tree, "inspect-reply-held");
    assert!(
        registry.entries.try_lock().is_ok(),
        "actual child query runs outside registry lock"
    );
    assert!(
        preparation.settle_native(end()).is_err(),
        "same native record is busy, not silently extracted"
    );
    tree.write("release-inspect-reply", b"release exact child");
    query.join().unwrap().unwrap();
    let preparation =
        Arc::try_unwrap(preparation).unwrap_or_else(|_| panic!("actual query joined"));
    preparation
        .stop_after_policy(&worker_config::policy_digest(&source))
        .unwrap();
    preparation
        .reclaim(end())
        .unwrap()
        .into_parts()
        .0
        .release(end())
        .unwrap();
    registry.runtime.close(end()).unwrap();
}
#[test]
fn unknown_stop_and_dropped_handle_leave_same_registry_owner_and_employee_lease() {
    crate::test_process::owning_case!(
        unknown_stop_and_dropped_handle_leave_same_registry_owner_and_employee_lease
    );
    let tree = Tree::new();
    let target = Target::new(&tree);
    let registry = registry(&tree, &target, SID);
    let source = source(&tree);
    let (claim, plan, process) = inputs(&registry, &source, SID);
    let preparation = claim.retain_replacement_stop(plan, process, None).unwrap();
    let mut changed: serde_json::Value =
        serde_json::from_slice(&fs::read(tree.0.join("after.json")).unwrap()).unwrap();
    changed[0]["Image"] = json!(format!("sha256:{}", "b".repeat(64)));
    tree.write("after.json", &serde_json::to_vec(&changed).unwrap());
    preparation.inspect().unwrap();
    assert!(
        preparation
            .stop_after_policy(&worker_config::policy_digest(&source))
            .is_err()
    );
    preparation.settle_native(end()).unwrap();
    let (preparation, _) = preparation.reclaim(end()).err().unwrap().into_parts();
    assert!(tree.0.join("source-reaped").exists());
    drop(preparation);
    let entries = registry.entries.lock().unwrap();
    assert!(matches!(&entries[0].owner, EntryOwner::ReplacementStop(_)));
    let identity = entries[0].identity.clone();
    drop(entries);
    assert!(registry.release(&identity, end()).is_err());
    assert!(registry.claim(&source, &sid(SID)).is_err());
    assert!(StorageLease::acquire_launch(&source, &sid(SID)).is_err());
    assert!(!registry.known_empty_for_service_drop());
    registry.runtime.close(end()).unwrap(); // Local engine close, not resource ACK.
}
#[test]
fn actual_legacy_stop_keeps_no_lease_or_registry_entry_and_returns_original_owner() {
    crate::test_process::owning_case!(
        actual_legacy_stop_keeps_no_lease_or_registry_entry_and_returns_original_owner
    );
    let tree = Tree::new();
    let target = Target::new(&tree);
    let registry = registry(&tree, &target, NEXT_SID);
    let source = source(&tree);
    let (claim, plan, process) = inputs(&registry, &source, NEXT_SID);
    assert!(matches!(&claim.state, ClaimState::Legacy { .. }));
    let preparation = claim.retain_replacement_stop(plan, process, None).unwrap();
    assert!(registry.entries.lock().unwrap().is_empty());
    let claim = finish_with_source(preparation, &source);
    assert!(matches!(&claim.state, ClaimState::Legacy { .. }));
    assert!(!claim.newly_claimed());
    assert!(registry.entries.lock().unwrap().is_empty());
    claim.release(end()).unwrap();
    registry.runtime.close(end()).unwrap();
}
