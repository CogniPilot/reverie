//! Real bootstrap/runtime, fixed owned Rust engine child, actual native signal
//! custody, native socket paths and recovery. Admission mode legitimately skips
//! pool kernel counters; no live cgroup/Engine/company is inspected here.
use super::*;
mod create_diagnostics;
mod native_cold;
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    time::Duration,
};
fn isolated(name: &str) -> bool {
    crate::test_process::isolate_case(&format!("installing_broker::service::tests::{name}"))
}
fn setup() -> (PathBuf, InstallingBroker) {
    super::super::recovered::tests::Tree::bootstrap_parts("", "admission", 512, 4096)
}
fn end() -> Instant {
    Instant::now() + Duration::from_secs(3)
}
fn close(owner: &mut StartupOwner) {
    owner.broker.request_stop();
    owner.close_listener_component().unwrap();
    owner.broker.close_command_telemetry(end()).unwrap();
    owner.broker.storage.runtime.close(end()).unwrap();
    owner
        .signals
        .as_mut()
        .unwrap()
        .finish_after_runtime_close()
        .unwrap();
}
fn wait(path: &Path) {
    let end = end();
    while !path.exists() {
        assert!(Instant::now() < end, "actual owned recovery query stage");
        std::thread::sleep(Duration::from_millis(1));
    }
}
struct Release(PathBuf);
impl Drop for Release {
    fn drop(&mut self) {
        fs::write(&self.0, b"release").unwrap();
    }
}
#[test]
fn actual_startup_prepares_parent_then_waits_for_recovery_before_any_listener_exists() {
    if isolated("actual_startup_prepares_parent_then_waits_for_recovery_before_any_listener_exists")
    {
        return;
    }
    let (root, broker) = setup();
    let broker = Arc::new(broker);
    let socket = root.join("control/broker.sock");
    fs::write(root.join("names.hold"), b"owned").unwrap();
    let source = root.clone();
    let alias = Arc::clone(&broker);
    let mut startup = std::thread::scope(|scope| {
        let observe = scope.spawn(move || {
            let _release = Release(source.join("names.release"));
            wait(&source.join("names.started"));
            // The original startup is actually blocked in its captured names
            // read. This SAME Arc alias must refuse before another native
            // signal owner, pool check, recovery query or listener is created.
            let refused = alias.prepare_shared_service().err().unwrap();
            assert!(matches!(
                refused.cause(),
                BrokerStartupCause::AlreadyAttempted
            ));
            assert!(Arc::ptr_eq(&alias, &refused.owner.broker));
            assert!(refused.owner.signals.is_none() && refused.owner.listener.is_none());
            drop(refused);
            assert!(
                source.join("control").is_dir(),
                "raw parent phase precedes actual recovery"
            );
            assert!(!source.join("control/broker.sock").exists());
            assert!(
                std::os::unix::net::UnixStream::connect(source.join("control/broker.sock"))
                    .is_err()
            );
        });
        let startup = broker.prepare_shared_service().unwrap();
        observe.join().unwrap();
        startup
    });
    assert!(Arc::ptr_eq(&broker, &startup.owner.broker));
    assert_eq!(
        (
            startup.recovered().selected(),
            startup.recovered().registered()
        ),
        (0, 0)
    );
    assert!(
        !socket.exists(),
        "prefix is not fake readiness or a bound service"
    );
    assert!(
        fs::read_to_string(root.join("calls.txt"))
            .unwrap()
            .contains("ps\0--filter\0label=reverie.worker=test\0--format\0{{.Names}}")
    );
    close(&mut startup.owner);
    drop(startup);
    // Checked local closure does not renew service-start authority, even
    // while the original outer bootstrap still retains this SAME Arc.
    let refused = broker.prepare_shared_service().err().unwrap();
    assert!(matches!(
        refused.cause(),
        BrokerStartupCause::AlreadyAttempted
    ));
    assert!(Arc::ptr_eq(&broker, &refused.owner.broker));
    assert!(refused.owner.signals.is_none() && refused.owner.listener.is_none());
    drop(refused);
    drop(broker);
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn actual_bad_parent_refuses_before_recovery_and_keeps_same_runtime_until_checked_close() {
    if isolated(
        "actual_bad_parent_refuses_before_recovery_and_keeps_same_runtime_until_checked_close",
    ) {
        return;
    }
    let (root, broker) = setup();
    let broker = Arc::new(broker);
    fs::create_dir(root.join("control")).unwrap();
    fs::set_permissions(root.join("control"), fs::Permissions::from_mode(0o755)).unwrap();
    let mut failure = broker.prepare_shared_service().err().unwrap();
    assert!(matches!(failure.cause(), BrokerStartupCause::Listener(_)));
    assert!(Arc::ptr_eq(&broker, &failure.owner.broker));
    // Even correcting the owned parent cannot reopen a consumed attempt or
    // replace the original partial signal/listener owners with fresh ones.
    fs::set_permissions(root.join("control"), fs::Permissions::from_mode(0o700)).unwrap();
    let refused = broker.prepare_shared_service().err().unwrap();
    assert!(matches!(
        refused.cause(),
        BrokerStartupCause::AlreadyAttempted
    ));
    assert!(Arc::ptr_eq(&broker, &refused.owner.broker));
    assert!(refused.owner.signals.is_none() && refused.owner.listener.is_none());
    drop(refused);
    assert!(
        !root.join("calls.txt").exists(),
        "no recovery native constructor before socket-parent acceptance"
    );
    assert!(!root.join("control/broker.sock").exists());
    failure.close_listener_component().unwrap();
    close(&mut failure.owner);
    drop(failure);
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn actual_recovery_failure_preserves_whole_startup_and_never_binds_a_socket() {
    if isolated("actual_recovery_failure_preserves_whole_startup_and_never_binds_a_socket") {
        return;
    }
    let (root, broker) = setup();
    // The actual fixed native child fails its names read; no callback/native
    // result value is substituted for the real captured client transaction.
    fs::remove_file(root.join("names.out")).unwrap();
    let mut failure = broker.prepare_service().err().unwrap();
    assert!(matches!(failure.cause(), BrokerStartupCause::Recovery(_)));
    assert!(root.join("control").is_dir());
    assert!(!root.join("control/broker.sock").exists());
    assert!(root.join("calls.txt").is_file());
    failure.close_listener_component().unwrap();
    close(&mut failure.owner);
    drop(failure);
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn actual_current_poison_keeps_bootstrap_and_signal_owners_without_socket_or_recovery_effects() {
    if isolated(
        "actual_current_poison_keeps_bootstrap_and_signal_owners_without_socket_or_recovery_effects",
    ) {
        return;
    }
    let (root, broker) = setup();
    let poisoned = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _held = broker.installed.current.write().unwrap();
        panic!("owned current lock poison");
    }));
    assert!(poisoned.is_err());
    let mut failure = broker.prepare_service().err().unwrap();
    assert!(matches!(
        failure.cause(),
        BrokerStartupCause::Configuration(_)
    ));
    assert!(!root.join("control").exists());
    assert!(!root.join("calls.txt").exists());
    close(&mut failure.owner);
    drop(failure);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn retained_pool_start_requires_installed_policy_before_listener_or_engine_calls() {
    if isolated("retained_pool_start_requires_installed_policy_before_listener_or_engine_calls") {
        return;
    }
    let (root, broker) = setup();
    let anchor = serde_json::from_value(serde_json::json!({
        "containerId": "a".repeat(64), "originalBirthDigest": "b".repeat(64),
        "bootId": "11111111-1111-4111-8111-111111111111",
        "pid": 42, "processStart": "50", "parentIdentity": [12, 22], "leafIdentity": [12, 27],
    }))
    .unwrap();
    let mut failure = broker
        .prepare_service_with_retained_pool(
            anchor,
            reverie_contracts::worker_service::NativeWorkerServiceRole::Broker,
        )
        .err()
        .unwrap();
    assert!(matches!(
        failure.cause(),
        BrokerStartupCause::PoolRestore(error) if error.code() == "WORKER_POOL_PROVIDER_REQUIRED"
    ));
    assert!(failure.owner.listener.is_none());
    assert!(!root.join("control").exists());
    assert!(!root.join("calls.txt").exists());
    close(&mut failure.owner);
    drop(failure);
    fs::remove_dir_all(root).unwrap();
}
