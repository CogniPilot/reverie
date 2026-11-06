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
    let task = std::thread::spawn(move || {
        reader.query(
            EngineQuery::InventoryIds,
            Instant::now() + Duration::from_millis(80),
            &CancellationToken::new(),
        )
    });
    let until = deadline();
    while !gate.entered.load(Ordering::Acquire) {
        assert!(Instant::now() < until);
        std::thread::sleep(Duration::from_millis(1));
    }
    assert!(task.join().unwrap().unwrap_err().is_uncertain());
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
