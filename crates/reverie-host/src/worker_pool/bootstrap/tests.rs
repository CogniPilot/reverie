//! Isolated original SELF/PIDFD and partial-owner controls, not a positive
//! native-broker package, delegation, maintenance or installed-pool fixture.
use super::*;
use crate::{engine_metadata::EngineBootstrap, installed_worker_engine::InstalledWorkerEngine};
use reverie_core::{
    resources::{BudgetMode, CpuQuota, ResourcePolicy},
    worker_schema::{WorkerBase, WorkerIds},
};
use std::{collections::BTreeMap, fs, os::fd::AsRawFd, time::Duration};
fn isolated(name: &str) -> bool {
    crate::test_process::isolate_case(&format!("worker_pool::bootstrap::tests::{name}"))
}
fn runtime() -> WorkerRuntime {
    // This inert engine capture never executes the test ELF or any query.
    let capture = EngineBootstrap::from_service(
        std::env::current_exe().unwrap().as_os_str(),
        BTreeMap::new(),
        fs::canonicalize(std::env::temp_dir()).unwrap(),
    )
    .unwrap();
    let base = WorkerBase::try_new(
        "binding-fixture".into(),
        "binding-server".into(),
        format!("sha256:{}", "a".repeat(64)),
        WorkerIds::try_new(native::uid(), nix::unistd::getgid().as_raw()).unwrap(),
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
    .unwrap();
    WorkerRuntime::new(InstalledWorkerEngine::new(capture), &base)
}
fn end() -> Instant {
    Instant::now() + Duration::from_secs(5)
}
fn stamp(fd: i32) -> (i32, u64, u64) {
    let m = fs::metadata(format!("/proc/self/fd/{fd}")).unwrap();
    (fd, m.dev(), m.ino())
}
fn still_open(original: (i32, u64, u64)) {
    assert_eq!(stamp(original.0), original);
}
#[test]
fn actual_self_pidfd_survives_known_pair_close_without_qualifying_a_program() {
    if isolated("actual_self_pidfd_survives_known_pair_close_without_qualifying_a_program") {
        return;
    }
    let runtime = runtime();
    let mut owner = BrokerBootstrapBinding::unopened(&runtime);
    owner.pin_self().unwrap();
    owner.pidfd_live().unwrap();
    let pair = owner
        .pair
        .iter()
        .map(|fd| stamp(fd.as_ref().unwrap().as_raw_fd()))
        .collect::<Vec<_>>();
    owner.close_pair().unwrap();
    owner.pidfd_live().unwrap();
    for original in pair {
        assert!(fs::metadata(format!("/proc/self/fd/{}", original.0)).is_err());
    }
    assert!(owner.program.is_none() && owner.process.is_none());
    owner.close().unwrap();
    assert!(owner.pidfd.is_none());
    assert_eq!(
        owner.pidfd_live().unwrap_err().code(),
        "WORKER_POOL_BROKER_PIDFD_UNKNOWN"
    );
    runtime.close(end()).unwrap();
}
#[test]
fn abandoned_partial_binding_keeps_original_socketpair_and_pidfd() {
    if isolated("abandoned_partial_binding_keeps_original_socketpair_and_pidfd") {
        return;
    }
    let runtime = runtime();
    let mut owner = BrokerBootstrapBinding::unopened(&runtime);
    owner.pin_self().unwrap();
    let mut retained = owner
        .pair
        .iter()
        .map(|fd| stamp(fd.as_ref().unwrap().as_raw_fd()))
        .collect::<Vec<_>>();
    retained.push(stamp(owner.pidfd.as_ref().unwrap().as_raw_fd()));
    drop(owner);
    for original in retained {
        still_open(original);
    }
    // Isolated child termination reclaims these deliberately abandoned FDs;
    // their Drop is never reported as a successful native finalizer.
    runtime.close(end()).unwrap();
}
#[test]
fn consumed_close_stays_unknown_without_touching_reused_descriptor() {
    if isolated("consumed_close_stays_unknown_without_touching_reused_descriptor") {
        return;
    }
    let runtime = runtime();
    let mut owner = BrokerBootstrapBinding::unopened(&runtime);
    owner.pin_self().unwrap();
    let original = owner.pair[0].as_ref().unwrap().as_raw_fd();
    native::test_faults::set(None, true);
    assert!(owner.close_pair().is_err());
    let sentinel = File::open("/dev/null").unwrap();
    assert_eq!(sentinel.as_raw_fd(), original);
    let retained = stamp(sentinel.as_raw_fd());
    assert!(owner.close().is_err());
    assert!(owner.close().is_err());
    still_open(retained);
    native::close(sentinel).unwrap();
    runtime.close(end()).unwrap();
}
#[test]
fn foreign_runtime_refuses_before_native_process_observation() {
    if isolated("foreign_runtime_refuses_before_native_process_observation") {
        return;
    }
    let original = runtime();
    let foreign = runtime();
    let mut owner = BrokerBootstrapBinding::unopened(&original);
    owner.pin_self().unwrap();
    let retained = stamp(owner.pidfd.as_ref().unwrap().as_raw_fd());
    assert_eq!(
        owner.assert_current(&foreign, end()).unwrap_err().code(),
        "WORKER_POOL_BROKER_RUNTIME_CHANGED"
    );
    assert!(owner.process.is_none());
    still_open(retained);
    owner.close().unwrap();
    original.close(end()).unwrap();
    foreign.close(end()).unwrap();
}
#[test]
fn missing_packaged_origin_refuses_before_any_native_open_or_socket() {
    if isolated("missing_packaged_origin_refuses_before_any_native_open_or_socket") {
        return;
    }
    let runtime = runtime();
    let mut owner = BrokerBootstrapBinding::unopened(&runtime);
    assert_eq!(
        owner.capture(&runtime, end(), None).unwrap_err().code(),
        "WORKER_POOL_NATIVE_BROKER_NOT_PACKAGED"
    );
    assert!(
        owner.manifest.is_none() && owner.pidfd.is_none() && owner.pair.iter().all(Option::is_none)
    );
    owner.close().unwrap();
    runtime.close(end()).unwrap();
}
#[test]
fn consumed_process_metadata_close_cannot_be_hidden_by_binding_cleanup() {
    if isolated("consumed_process_metadata_close_cannot_be_hidden_by_binding_cleanup") {
        return;
    }
    let runtime = runtime();
    let mut owner = BrokerBootstrapBinding::unopened(&runtime);
    owner.pin_self().unwrap();
    native::test_faults::set(None, true);
    assert!(owner.processes.observe_current_broker(end()).is_err());
    assert!(owner.close().is_err());
    assert!(owner.close().is_err());
    runtime.close(end()).unwrap();
}
