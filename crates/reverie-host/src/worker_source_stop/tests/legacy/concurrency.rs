use super::*;
use crate::engine_metadata::{CancellationToken, EngineQuery};
use std::{
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
struct Release(PathBuf);
impl Drop for Release {
    fn drop(&mut self) {
        fs::write(&self.0, b"owned known release").unwrap();
    }
}
fn wait(mut ready: impl FnMut() -> bool) {
    let end = end();
    while !ready() {
        assert!(Instant::now() < end, "owned concurrency phase");
        std::thread::sleep(Duration::from_millis(1));
    }
}
#[test]
fn actual_worker_waits_for_unrelated_metadata_before_admission_then_stops_once() {
    if isolated(
        "worker_source_stop::tests::legacy::concurrency::actual_worker_waits_for_unrelated_metadata_before_admission_then_stops_once",
    ) {
        return;
    }
    let fixture = Fixture::new("stop-requested");
    let (storage, plan, original) = inputs(&fixture);
    let address = std::ptr::from_ref(storage.as_ref());
    let mut owner = fixture
        .runtime
        .retain_ordinary_laptop_stop_for_worker(storage, plan, original)
        .unwrap_or_else(|_| panic!("same original inputs"));
    std::thread::scope(|scope| {
        let release = Release(fixture.root.join("release-metadata"));
        let readonly = fixture.runtime.readonly();
        let metadata = scope.spawn(move || {
            readonly.query(EngineQuery::InventoryIds, end(), &CancellationToken::new())
        });
        wait(|| fixture.root.join("metadata-entered").is_file());
        let probe = Arc::new(AtomicBool::new(false));
        let observe = probe.clone();
        let stop = scope.spawn(|| {
            call::probe::observe_next(observe);
            owner.stop_after_admission(&fixture.runtime)
        });
        wait(|| probe.load(Ordering::Acquire));
        assert!(!fixture.root.join("stop-requested").exists());
        drop(release);
        assert_eq!(metadata.join().unwrap().unwrap(), "");
        let result = stop.join().unwrap();
        assert!(
            result.is_ok(),
            "actual metadata admission must settle before stop: {result:?}"
        );
    });
    assert!(fixture.root.join("source-reaped").exists());
    assert_eq!(
        fixture
            .trace()
            .iter()
            .filter(|line| line.starts_with("stop\0"))
            .count(),
        1
    );
    restore(&fixture, &mut owner, address);
}
#[test]
fn actual_first_stop_expiry_while_waiting_never_dispatches_or_reclaims() {
    if isolated(
        "worker_source_stop::tests::legacy::concurrency::actual_first_stop_expiry_while_waiting_never_dispatches_or_reclaims",
    ) {
        return;
    }
    let fixture = Fixture::new("never");
    let (storage, plan, original) = inputs(&fixture);
    let mut owner = fixture
        .runtime
        .retain_ordinary_laptop_stop_for_worker(storage, plan, original)
        .unwrap_or_else(|_| panic!("same original inputs"));
    std::thread::scope(|scope| {
        let release = Release(fixture.root.join("release-metadata"));
        let readonly = fixture.runtime.readonly();
        let metadata = scope.spawn(move || {
            readonly.query(EngineQuery::InventoryIds, end(), &CancellationToken::new())
        });
        wait(|| fixture.root.join("metadata-entered").is_file());
        let probe = Arc::new(AtomicBool::new(false));
        let observe = probe.clone();
        let stop = scope.spawn(|| {
            call::probe::observe_next(observe);
            owner.stop_after_admission(&fixture.runtime)
        });
        wait(|| probe.load(Ordering::Acquire));
        fixture
            .runtime
            .installed_engine()
            .expire_stop_for_owned_test();
        // Wait for the attempted stop result while the unrelated native job
        // remains owned; a new admission cannot race the actual expiry.
        let error = stop.join().unwrap().unwrap_err();
        assert_eq!(error.code(), "RESOURCE_SOURCE_STOP_DEADLINE");
        drop(release);
        assert_eq!(metadata.join().unwrap().unwrap(), "");
    });
    assert!(!fixture.root.join("stop-requested").exists());
    owner.settle_native(&fixture.runtime, end()).unwrap();
    assert!(owner.take_stopped(&fixture.runtime, end()).is_err());
    fixture.assert_held();
}
