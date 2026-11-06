use super::*;
use crate::installed_worker_engine::InstalledWorkerEngine;
use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Tree(PathBuf);
impl Tree {
    fn new() -> Self {
        let _ = super::tests::program();
        let path = std::env::temp_dir().join(format!(
            "installed-engine-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        Self(path)
    }
    fn bootstrap(&self, name: &str) -> EngineBootstrap {
        let path = self.0.join(name);
        fs::hard_link(super::tests::program(), &path).unwrap();
        EngineBootstrap::from_service(path.as_os_str(), BTreeMap::new(), self.0.clone()).unwrap()
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(2)
}
#[test]
fn actual_first_stop_is_shared_without_restarting_budget_or_sealing_cleanup_reads() {
    let tree = Tree::new();
    let bootstrap = tree.bootstrap("argv");
    let starts = bootstrap.hooks.starts.clone();
    let installed = InstalledWorkerEngine::new(bootstrap);
    assert!(installed.stop_deadline().is_none());
    let before = Instant::now();
    let deadlines = std::thread::scope(|scope| {
        (0..8)
            .map(|_| {
                scope.spawn(|| {
                    let deadline = installed.request_stop();
                    assert!(installed.cancellation().is_cancelled());
                    assert_eq!(installed.stop_deadline(), Some(deadline));
                    deadline
                })
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|task| task.join().unwrap())
            .collect::<Vec<_>>()
    });
    let after = Instant::now();
    let stop = deadlines[0];
    assert!(deadlines.iter().all(|deadline| *deadline == stop));
    assert!(stop >= before + Duration::from_secs(34));
    assert!(stop <= after + Duration::from_secs(34));
    assert!(
        installed
            .readonly()
            .query(
                EngineQuery::InventoryIds,
                deadline(),
                &installed.cancellation()
            )
            .is_err()
    );
    assert_eq!(starts.load(Ordering::SeqCst), 0);
    // A separate cleanup-purpose cancellation token can still use the SAME
    // process context before final sealing. It grants no new effect command.
    assert_eq!(
        installed
            .readonly()
            .query(
                EngineQuery::InventoryIds,
                deadline(),
                &CancellationToken::new()
            )
            .unwrap(),
        "ps\0-aq\0--no-trunc"
    );
    assert_eq!(starts.load(Ordering::SeqCst), 1);
    assert_eq!(installed.request_stop(), stop);
    installed.close(deadline()).unwrap();
    assert_eq!(installed.stop_deadline(), Some(stop));
}
#[test]
fn actual_service_readers_share_capture_and_permanent_close_fence() {
    let tree = Tree::new();
    let bootstrap = tree.bootstrap("argv");
    let starts = bootstrap.hooks.starts.clone();
    let installed = InstalledWorkerEngine::new(bootstrap);
    let first = installed.readonly();
    let second = installed.readonly();
    assert!(Arc::ptr_eq(&first.client, &second.client));
    assert_eq!(
        first
            .query(
                EngineQuery::InventoryIds,
                deadline(),
                &installed.cancellation()
            )
            .unwrap(),
        "ps\0-aq\0--no-trunc"
    );
    assert_eq!(starts.load(Ordering::SeqCst), 1);
    installed.close(deadline()).unwrap();
    assert!(installed.cancellation().is_cancelled());
    assert!(installed.stop_deadline().is_some());
    for reader in [first, second, installed.readonly()] {
        assert!(
            reader
                .query(
                    EngineQuery::InventoryIds,
                    deadline(),
                    &CancellationToken::new()
                )
                .is_err()
        );
    }
    assert_eq!(starts.load(Ordering::SeqCst), 1);
    installed.settle_owned(deadline()).unwrap();
}
#[test]
fn pending_constructor_remains_owned_across_all_clones_and_close_never_reopens() {
    let tree = Tree::new();
    let mut bootstrap = tree.bootstrap("stall");
    let gate = Arc::new(super::tests::Gate::default());
    bootstrap.hooks.gate = Some(gate.clone());
    let starts = bootstrap.hooks.starts.clone();
    let installed = InstalledWorkerEngine::new(bootstrap);
    let reader = installed.readonly();
    let cancellation = CancellationToken::new();
    let query_cancellation = cancellation.clone();
    let task = std::thread::spawn(move || {
        reader.query(
            EngineQuery::InventoryIds,
            Instant::now() + Duration::from_secs(20),
            &query_cancellation,
        )
    });
    let until = deadline();
    while !gate.entered.load(Ordering::Acquire) && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(1));
    }
    let entered = gate.entered.load(Ordering::Acquire);
    cancellation.cancel();
    if !entered {
        gate.released.store(true, Ordering::Release);
    }
    let result = task.join().unwrap();
    assert!(entered, "owned constructor actually reached its gate");
    assert!(result.unwrap_err().is_uncertain());
    let other = installed.readonly();
    assert_eq!(
        other
            .query(
                EngineQuery::InventoryIds,
                deadline(),
                &CancellationToken::new()
            )
            .unwrap_err()
            .fault(),
        EngineFault::Busy
    );
    assert!(
        installed
            .close(Instant::now() + Duration::from_millis(50))
            .is_err()
    );
    gate.released.store(true, Ordering::Release);
    installed.settle_owned(deadline()).unwrap();
    assert!(
        other
            .query(
                EngineQuery::InventoryIds,
                deadline(),
                &CancellationToken::new()
            )
            .is_err()
    );
    assert_eq!(starts.load(Ordering::SeqCst), 1);
}

#[test]
fn settlement_after_expired_actual_stop_does_not_take_the_callers_fresh_budget() {
    let tree = Tree::new();
    let mut bootstrap = tree.bootstrap("stall");
    let gate = Arc::new(super::tests::Gate::default());
    bootstrap.hooks.gate = Some(gate.clone());
    let installed = InstalledWorkerEngine::new(bootstrap);
    let reader = installed.readonly();
    let cancellation = CancellationToken::new();
    let query_cancellation = cancellation.clone();
    let task = std::thread::spawn(move || {
        reader.query(
            EngineQuery::InventoryIds,
            Instant::now() + Duration::from_secs(20),
            &query_cancellation,
        )
    });
    let end = deadline();
    while !gate.entered.load(Ordering::Acquire) {
        assert!(Instant::now() < end);
        std::thread::sleep(Duration::from_millis(1));
    }
    // Establish the actual pending constructor before ending its query. A
    // short startup deadline could expire before the constructor reached this
    // gate, testing scheduler timing instead of expired-stop settlement.
    cancellation.cancel();
    assert!(task.join().unwrap().unwrap_err().is_uncertain());
    installed.expire_stop_for_owned_test();
    let before = Instant::now();
    assert!(installed.settle_owned(deadline()).is_err());
    assert!(
        before.elapsed() < Duration::from_millis(500),
        "controlled blocked constructor must not get a fresh2s budget"
    );
    gate.released.store(true, Ordering::Release);
    // Cleanup may be observed later, but every service attempt retains the
    // SAME expired deadline; the test never grants it a replacement budget.
    let end = deadline();
    while installed.settle_owned(deadline()).is_err() {
        assert!(Instant::now() < end);
        std::thread::sleep(Duration::from_millis(1));
    }
    installed.close(deadline()).unwrap();
}
