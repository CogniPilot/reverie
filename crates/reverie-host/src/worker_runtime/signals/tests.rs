//! Each process installs only its own fixed handlers. No parent/host PID,
//! unregistered fault signal, process group or altered global limit is used.
use super::*;
use crate::{
    engine_metadata::EngineBootstrap,
    native::child_signals::{self, OwnedBrokerSignal},
};
use std::{collections::BTreeMap, time::Duration};
fn isolated(name: &str) -> bool {
    crate::test_process::isolate_case(&format!("worker_runtime::signals::tests::{name}"))
}
fn runtime() -> WorkerRuntime {
    let bootstrap = EngineBootstrap::from_service(
        std::env::current_exe().unwrap().as_os_str(),
        BTreeMap::new(),
        std::fs::canonicalize(std::env::temp_dir()).unwrap(),
    )
    .unwrap();
    WorkerRuntime::new(
        InstalledWorkerEngine::new(bootstrap),
        &super::super::tests::base('a', 1024),
    )
}
fn end() -> Instant {
    Instant::now() + Duration::from_secs(2)
}
#[test]
fn actual_signal_cancels_existing_clones_and_keeps_its_original_deadline_without_a_watcher() {
    if isolated(
        "actual_signal_cancels_existing_clones_and_keeps_its_original_deadline_without_a_watcher",
    ) {
        return;
    }
    let runtime = runtime();
    let token = runtime.cancellation();
    let unrelated = CancellationToken::new();
    assert!(!token.is_cancelled());
    let mut signals = runtime.install_broker_signals().unwrap();
    assert!(!token.is_cancelled());
    assert_eq!(runtime.stop_deadline(), None);
    let before = Instant::now();
    child_signals::raise_for_owned_broker_test(OwnedBrokerSignal::Terminate);
    assert!(token.is_cancelled());
    assert!(
        !unrelated.is_cancelled(),
        "ordinary/default metadata tokens remain independent"
    );
    let first = runtime.stop_deadline().unwrap();
    assert_eq!(
        first,
        child_signals::clamp(before + Duration::from_secs(60))
    );
    assert!(first <= Instant::now() + Duration::from_secs(34));
    std::thread::sleep(Duration::from_millis(5));
    assert_eq!(runtime.request_stop(), first, "no watcher-latency grace");
    child_signals::raise_for_owned_broker_test(OwnedBrokerSignal::Interrupt);
    assert_eq!(runtime.stop_deadline(), Some(first));
    assert_eq!(signals.termination_signal(), Some(libc::SIGTERM));
    runtime.close(end()).unwrap();
    signals.finish_after_runtime_close().unwrap();
    signals.finish_after_runtime_close().unwrap();
}
#[test]
fn another_actual_guard_cannot_attach_its_signals_to_a_foreign_engine() {
    if isolated("another_actual_guard_cannot_attach_its_signals_to_a_foreign_engine") {
        return;
    }
    let first = runtime();
    let other = runtime();
    let mut signals = first.install_broker_signals().unwrap();
    assert!(signals.finish_after_runtime_close().is_err());
    assert!(first.install_broker_signals().is_err());
    let mut failure = other.install_broker_signals().err().unwrap();
    assert!(!failure.error().restoration_unconfirmed());
    assert!(
        failure.finish_after_runtime_close().is_ok(),
        "no foreign guard was adopted"
    );
    child_signals::raise_for_owned_broker_test(OwnedBrokerSignal::Terminate);
    assert!(first.cancellation().is_cancelled());
    assert!(!other.cancellation().is_cancelled());
    assert_eq!(other.stop_deadline(), None);
    other.close(end()).unwrap();
    first.close(end()).unwrap();
    signals.finish_after_runtime_close().unwrap();
}
#[test]
fn finished_signal_source_is_frozen_before_a_later_standalone_installation_resets_globals() {
    if isolated(
        "finished_signal_source_is_frozen_before_a_later_standalone_installation_resets_globals",
    ) {
        return;
    }
    let first = runtime();
    let mut original = first.install_broker_signals().unwrap();
    child_signals::raise_for_owned_broker_test(OwnedBrokerSignal::Terminate);
    let deadline = first.stop_deadline();
    first.close(end()).unwrap();
    original.finish_after_runtime_close().unwrap();
    let later = runtime();
    let mut new = later.install_broker_signals().unwrap();
    assert_eq!(later.stop_deadline(), None);
    assert!(!later.cancellation().is_cancelled());
    assert_eq!(first.stop_deadline(), deadline);
    assert_eq!(original.termination_signal(), Some(libc::SIGTERM));
    later.close(end()).unwrap();
    new.finish_after_runtime_close().unwrap();
}
#[test]
fn abandoned_scope_keeps_the_actual_guard_and_origin_and_refuses_replacement() {
    if isolated("abandoned_scope_keeps_the_actual_guard_and_origin_and_refuses_replacement") {
        return;
    }
    let original = runtime();
    let weak = Arc::downgrade(original.installed_engine());
    let signals = original.install_broker_signals().unwrap();
    drop(signals);
    drop(original);
    assert!(weak.upgrade().is_some());
    let replacement = runtime();
    assert!(replacement.install_broker_signals().is_err());
    assert!(!replacement.cancellation().is_cancelled());
    replacement.close(end()).unwrap();
}
#[test]
fn restoration_failure_is_sticky_and_preserves_origin_without_retrying_consumed_guard() {
    if isolated(
        "restoration_failure_is_sticky_and_preserves_origin_without_retrying_consumed_guard",
    ) {
        return;
    }
    let original = runtime();
    let weak = Arc::downgrade(original.installed_engine());
    let mut signals = original.install_broker_signals().unwrap();
    original.close(end()).unwrap();
    child_signals::fail_restore_once();
    assert!(
        signals
            .finish_after_runtime_close()
            .unwrap_err()
            .restoration_unconfirmed()
    );
    assert!(
        signals.guard.is_none(),
        "consumed finalizer is never retried"
    );
    assert!(signals.finish_after_runtime_close().is_err());
    drop(signals);
    drop(original);
    assert!(weak.upgrade().is_some());
    let later = runtime();
    assert!(later.install_broker_signals().is_err());
    later.close(end()).unwrap();
}
#[test]
fn an_already_stopping_runtime_cannot_install_and_manual_stop_cannot_be_extended_by_a_signal() {
    if isolated(
        "an_already_stopping_runtime_cannot_install_and_manual_stop_cannot_be_extended_by_a_signal",
    ) {
        return;
    }
    let stopped = runtime();
    stopped.close(end()).unwrap();
    assert!(stopped.install_broker_signals().is_err());
    let original = runtime();
    let mut signals = original.install_broker_signals().unwrap();
    let first = original.request_stop();
    child_signals::raise_for_owned_broker_test(OwnedBrokerSignal::Terminate);
    assert_eq!(original.stop_deadline(), Some(first));
    original.close(end()).unwrap();
    signals.finish_after_runtime_close().unwrap();
}
