//! Actual owned files and the existing consumed-close fault. Controlled
//! policy/Engine prelude DATA never constitutes a positive installed pool.
use super::*;
use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf};

fn isolated(name: &str) -> bool {
    crate::test_process::isolate_case(&format!("worker_pool::policy::tests::{name}"))
}
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("pool-policy-partial-{}", std::process::id()));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn opening(&self, raw: &[u8]) -> OpeningPolicy {
        let digest: [u8; 32] = Sha256::digest(raw).into();
        let mut opening = OpeningPolicy::new(digest);
        fs::write(self.0.join(&opening.filename), raw).unwrap();
        fs::set_permissions(
            self.0.join(&opening.filename),
            fs::Permissions::from_mode(0o440),
        )
        .unwrap();
        opening.open_directory(&self.0).unwrap();
        opening.open_file().unwrap();
        opening
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn stamp(file: &File) -> (i32, u64, u64) {
    let m = file.metadata().unwrap();
    (file.as_raw_fd(), m.dev(), m.ino())
}
fn still_open(value: (i32, u64, u64)) {
    let m = fs::metadata(format!("/proc/self/fd/{}", value.0)).unwrap();
    assert_eq!((m.dev(), m.ino()), (value.1, value.2));
}
fn policy_bytes() -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "version":1,"purpose":"reverie-docker-worker-pool-v1","deployment":"owned-policy",
        "instanceRoot":"/home/owned/reverie","engineId":"11111111-1111-4111-8111-111111111111",
        "anchorImage":format!("sha256:{}","a".repeat(64)),"controllerImage":format!("sha256:{}","b".repeat(64)),
        "websiteContainer":"c".repeat(64),"brokerUid":1000,"brokerGid":1000,"memoryMaxMiB":49152,
        "poolTasksMax":8192,"cpuWeight":100,"allowedCpus":[0,1],
        "employeeMemoryHighMiB":{"22222222-2222-4222-8222-222222222222":512}
    })).unwrap()
}

#[test]
fn missing_version_returns_same_open_directory_and_known_close() {
    if isolated("missing_version_returns_same_open_directory_and_known_close") {
        return;
    }
    let tree = Tree::new();
    let mut opening = OpeningPolicy::new([0; 32]);
    opening.open_directory(&tree.0).unwrap();
    let original = stamp(opening.directory.as_ref().unwrap());
    let primary = opening.open_file().unwrap_err();
    let mut failure = ControllerPoolPolicyFailure::opening(opening, primary);
    still_open(original);
    assert!(matches!(failure.owner, Some(FailureOwner::Opening(_))));
    failure.close().unwrap();
    failure.close().unwrap();
    assert!(failure.known_closed);
}

#[test]
fn invalid_policy_default_drop_retains_original_descriptors() {
    if isolated("invalid_policy_default_drop_retains_original_descriptors") {
        return;
    }
    let tree = Tree::new();
    let mut opening = tree.opening(b"{}");
    let original_file = stamp(opening.file.as_ref().unwrap());
    let original_dir = stamp(opening.directory.as_ref().unwrap());
    let primary = opening.capture_policy().unwrap_err();
    let failure = ControllerPoolPolicyFailure::opening(opening, primary);
    assert_eq!(failure.primary_error().code(), "WORKER_POOL_POLICY_INVALID");
    drop(failure);
    still_open(original_file);
    still_open(original_dir);
}

#[test]
fn consumed_close_refusal_stays_opaque_and_never_closes_reused_fd() {
    if isolated("consumed_close_refusal_stays_opaque_and_never_closes_reused_fd") {
        return;
    }
    let tree = Tree::new();
    let mut opening = tree.opening(b"{}");
    let primary = opening.capture_policy().unwrap_err();
    let mut failure = ControllerPoolPolicyFailure::opening(opening, primary);
    native::test_faults::set(None, true);
    assert!(failure.close().is_err());
    let sentinel = File::create(tree.0.join("sentinel")).unwrap();
    let original = stamp(&sentinel);
    assert!(failure.close().is_err());
    assert!(!failure.known_closed);
    assert_eq!(failure.primary_error().code(), "WORKER_POOL_POLICY_INVALID");
    still_open(original);
    native::close(sentinel).unwrap();
}

fn captured_opening(tree: &Tree) -> OpeningPolicy {
    let mut opening = tree.opening(&policy_bytes());
    opening.capture_policy().unwrap();
    // Controlled prelude only; no Engine endpoint is opened, and native
    // assert_current must reject before this unconnected observer can query.
    opening.controller = Some(super::super::namespace::ControllerProcessObservation {
        container: "d".repeat(64),
        pid: std::process::id(),
        start: "controlled".into(),
    });
    opening.engine = Some(super::super::engine::EngineObserver::unconnected_test_owner());
    opening
}

#[test]
fn final_native_validation_refusal_returns_whole_opened_owner() {
    if isolated("final_native_validation_refusal_returns_whole_opened_owner") {
        return;
    }
    let tree = Tree::new();
    let opening = captured_opening(&tree);
    let original = stamp(opening.file.as_ref().unwrap());
    // The exact production finish step, with actual retained files. Its
    // native namespace/credential refusal must not close those files.
    let mut failure = ControllerPoolPolicy::finish_open(opening).err().unwrap();
    still_open(original);
    assert!(matches!(failure.owner, Some(FailureOwner::Opened(_))));
    failure.close().unwrap();
    assert!(failure.known_closed);
}

#[test]
fn final_validation_consumed_close_never_becomes_known_after_policy_cleanup() {
    if isolated("final_validation_consumed_close_never_becomes_known_after_policy_cleanup") {
        return;
    }
    let tree = Tree::new();
    let opening = captured_opening(&tree);
    let original = stamp(opening.file.as_ref().unwrap());
    // The first real namespace proc read consumes/closes its own FD and the
    // existing hook reports uncertainty. Policy FDs remain the same owners.
    native::test_faults::set(None, true);
    let mut failure = ControllerPoolPolicy::finish_open(opening).err().unwrap();
    assert!(failure.primary_error().close_unknown());
    still_open(original);
    assert!(failure.close().is_err());
    assert!(failure.close().is_err());
    assert!(!failure.known_closed);
}

#[test]
fn pool_close_fences_confirmed_stage_before_fallible_metadata_close() {
    if isolated("pool_close_fences_confirmed_stage_before_fallible_metadata_close") {
        return;
    }
    let tree = Tree::new();
    let policy = captured_opening(&tree).into_policy();
    let directory = super::super::directory::PoolDirectory::unopened(policy.data());
    let mut pool = super::super::OpenedWorkerPool {
        policy,
        directory,
        anchor_id: "e".repeat(64),
        anchor_pid: std::process::id(),
        stage: super::super::InstallationStage::Confirmed,
    };
    // Confirmed is controlled state DATA here, never a native-positive proof.
    native::test_faults::set(None, true);
    assert!(pool.close().is_err());
    assert_eq!(pool.stage, super::super::InstallationStage::Closing);
    assert_eq!(
        pool.installed().err().unwrap().code(),
        "WORKER_POOL_INSTALLATION_UNKNOWN"
    );
    assert_eq!(
        pool.initialize().unwrap_err().code(),
        "WORKER_POOL_ATTEMPT_ALREADY_EXISTS"
    );
    assert!(pool.close().is_err());
}

#[test]
fn service_v2_birth_cannot_reuse_component_initialization_without_maintenance() {
    if isolated("service_v2_birth_cannot_reuse_component_initialization_without_maintenance") {
        return;
    }
    use reverie_contracts::worker_pool::{BrokerBirthData, BrokerProgramData, ControllerBirthV2};
    let tree = Tree::new();
    let policy = WorkerPoolPolicy::decode(&policy_bytes()).unwrap();
    let broker = BrokerBirthData::from_observations(
        std::process::id(),
        "123".into(),
        [policy.broker_uid, policy.broker_gid],
        [1, 2],
        [3, 4, 5],
        "a".repeat(64),
    )
    .unwrap();
    let program = BrokerProgramData::decode(
        &serde_json::to_vec(&serde_json::json!({
        "version":1,"purpose":"reverie-native-worker-broker-v1",
        "executable":"/nix/store/controlled-program/bin/reverie-worker-broker",
        "executableSHA256":"b".repeat(64),"bytes":4096}))
        .unwrap(),
    )
    .unwrap();
    let raw = ControllerBirthV2::from_observations(policy, broker, program)
        .unwrap()
        .encode()
        .unwrap();
    let mut opening = tree.opening(&raw);
    opening.service_v2 = true;
    opening.capture_policy().unwrap();
    // Explicit controlled prelude DATA, never a native-positive controller.
    opening.controller = Some(super::super::namespace::ControllerProcessObservation {
        container: "d".repeat(64),
        pid: std::process::id(),
        start: "controlled".into(),
    });
    opening.engine = Some(super::super::engine::EngineObserver::unconnected_test_owner());
    let policy = opening.into_policy();
    let directory = super::super::directory::PoolDirectory::unopened(policy.data());
    let mut pool = super::super::OpenedWorkerPool {
        policy,
        directory,
        anchor_id: "e".repeat(64),
        anchor_pid: std::process::id(),
        stage: super::super::InstallationStage::Ready,
    };
    assert_eq!(
        pool.initialize().unwrap_err().code(),
        "WORKER_POOL_SERVICE_MAINTENANCE_REQUIRED"
    );
    assert_eq!(pool.stage, super::super::InstallationStage::Ready);
    assert!(pool.directory.parent().is_err());
    pool.close().unwrap();
}
