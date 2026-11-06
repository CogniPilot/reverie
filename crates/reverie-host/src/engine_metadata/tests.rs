use super::*;
use std::os::unix::{ffi::OsStringExt, fs::PermissionsExt};
use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

pub(super) use crate::captured_client::test_hooks::{Gate, Hooks};
static NEXT: AtomicUsize = AtomicUsize::new(0);
static FIXTURE: OnceLock<PathBuf> = OnceLock::new();
pub(crate) fn program() -> &'static Path {
    FIXTURE.get_or_init(|| {
        let root = std::env::temp_dir().join(format!("engine-child-build-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let source = root.join("child.rs");
        fs::write(
            &source,
            include_str!("../../tests/support/engine_metadata_child.rs"),
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
struct Tree {
    root: PathBuf,
}
impl Tree {
    fn new() -> Self {
        let _ = program();
        let root = std::env::temp_dir().join(format!(
            "engine-metadata-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        Self { root }
    }
    fn bootstrap(&self, name: &str) -> EngineBootstrap {
        let path = self.root.join(name);
        fs::hard_link(program(), &path).unwrap();
        EngineBootstrap::from_service(path.as_os_str(), BTreeMap::new(), self.root.clone()).unwrap()
    }
    fn engine(&self, name: &str) -> ReadonlyEngine {
        ReadonlyEngine::new(self.bootstrap(name))
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}
fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(2)
}
fn settle(engine: &ReadonlyEngine) {
    engine.settle_owned(deadline()).unwrap();
}
#[test]
fn different_private_policies_share_the_same_pending_context_and_closed_admission() {
    use crate::captured_client::Policy;
    let tree = Tree::new();
    let mut bootstrap = tree.bootstrap("stall");
    let gate = Arc::new(Gate::default());
    bootstrap.hooks.gate = Some(Arc::clone(&gate));
    let starts = Arc::clone(&bootstrap.hooks.starts);
    let engine = Arc::new(ReadonlyEngine::new(bootstrap));
    let other = Arc::clone(&engine);
    let worker = std::thread::spawn(move || {
        other.client.run(
            vec![OsString::from("fixed-owned-test")],
            Instant::now() + Duration::from_millis(80),
            &CancellationToken::new(),
            Policy {
                maximum: Duration::from_secs(20),
                maximum_output: 4 * 1024 * 1024,
                successful_exit: false,
            },
        )
    });
    let until = deadline();
    while !gate.entered.load(Ordering::Acquire) {
        assert!(Instant::now() < until);
        std::thread::sleep(Duration::from_millis(1));
    }
    let error = worker.join().unwrap().err().unwrap();
    assert!(error.is_uncertain());
    assert_eq!(
        engine
            .query(
                EngineQuery::InventoryIds,
                deadline(),
                &CancellationToken::new()
            )
            .unwrap_err()
            .fault(),
        EngineFault::Busy
    );
    assert!(engine.close(Instant::now()).is_err());
    let still_pending = engine
        .query(
            EngineQuery::InventoryIds,
            deadline(),
            &CancellationToken::new(),
        )
        .unwrap_err();
    assert_eq!(still_pending.fault(), EngineFault::Busy);
    assert!(
        still_pending.is_uncertain(),
        "sealing admission cannot hide retained cleanup uncertainty"
    );
    gate.released.store(true, Ordering::Release);
    engine.close(deadline()).unwrap();
    assert_eq!(
        engine
            .query(
                EngineQuery::InventoryIds,
                deadline(),
                &CancellationToken::new()
            )
            .unwrap_err()
            .fault(),
        EngineFault::Busy
    );
    assert_eq!(starts.load(Ordering::Acquire), 1);
}
fn expected_argv(value: &serde_json::Value, name: &str) -> Vec<String> {
    value[name]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn fixed_query_arguments_and_closed_container_references_match_source() {
    let corpus: serde_json::Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/engine-metadata-argv.json"
    ))
    .unwrap();
    let tree = Tree::new();
    let engine = tree.engine("argv");
    let token = CancellationToken::new();
    let args = engine
        .query(EngineQuery::InventoryIds, deadline(), &token)
        .unwrap();
    assert_eq!(
        args.split('\0').collect::<Vec<_>>(),
        expected_argv(&corpus, "inventory")
    );
    let ids = [
        ContainerId::parse(&"a".repeat(64)).unwrap(),
        ContainerId::parse(&"0".repeat(64)).unwrap(),
    ];
    let args = engine
        .query(EngineQuery::InspectBatch(&ids), deadline(), &token)
        .unwrap();
    assert_eq!(
        args.split('\0').collect::<Vec<_>>(),
        expected_argv(&corpus, "inspect")
    );
    let args = engine
        .query(EngineQuery::InspectStopped(&ids[0]), deadline(), &token)
        .unwrap();
    assert_eq!(
        args.split('\0').collect::<Vec<_>>(),
        expected_argv(&corpus, "stopped")
    );
    assert_eq!(
        engine
            .query(EngineQuery::InspectBatch(&[]), deadline(), &token)
            .unwrap_err()
            .fault(),
        EngineFault::Query
    );
    assert!(ContainerId::parse("--privileged").is_err());
    settle(&engine);
}
#[test]
fn independent_stdout_and_stderr_backpressure_respects_exact_combined_bound() {
    let tree = Tree::new();
    let token = CancellationToken::new();
    let engine = tree.engine("dual");
    assert_eq!(
        engine
            .query(EngineQuery::InventoryIds, deadline(), &token)
            .unwrap()
            .len(),
        MAX_OUTPUT_BYTES / 2
    );
    settle(&engine);
    let engine = tree.engine("overflow");
    assert_eq!(
        engine
            .query(EngineQuery::InventoryIds, deadline(), &token)
            .unwrap_err()
            .fault(),
        EngineFault::OutputBound
    );
    settle(&engine);
}
#[test]
fn invalid_utf8_and_failed_status_never_return_rows_or_diagnostics() {
    let tree = Tree::new();
    let token = CancellationToken::new();
    for name in ["badout", "baderr", "failure"] {
        let engine = tree.engine(name);
        let error = engine
            .query(EngineQuery::InventoryIds, deadline(), &token)
            .unwrap_err();
        assert_eq!(
            error.fault(),
            if name == "failure" {
                EngineFault::Exit
            } else {
                EngineFault::Utf8
            }
        );
        assert!(!format!("{error:?}").contains("synthetic-private"));
        settle(&engine);
    }
}
#[test]
fn deadline_and_cancellation_kill_only_the_owned_client_and_settle_explicitly() {
    let tree = Tree::new();
    let engine = tree.engine("stall");
    let token = CancellationToken::new();
    let before = Instant::now();
    let error = engine
        .query(
            EngineQuery::InventoryIds,
            Instant::now() + Duration::from_millis(80),
            &token,
        )
        .unwrap_err();
    assert_eq!(error.fault(), EngineFault::Deadline);
    assert!(before.elapsed() < Duration::from_secs(1));
    settle(&engine);
    token.cancel();
    assert_eq!(
        engine
            .query(EngineQuery::InventoryIds, deadline(), &token)
            .unwrap_err()
            .fault(),
        EngineFault::Cancelled
    );
    settle(&engine);
}
#[test]
fn inherited_pipe_writers_fence_new_queries_until_owned_pipe_cleanup_finishes() {
    let tree = Tree::new();
    let engine = tree.engine("descendant");
    let token = CancellationToken::new();
    let error = engine
        .query(
            EngineQuery::InventoryIds,
            Instant::now() + Duration::from_millis(50),
            &token,
        )
        .unwrap_err();
    assert!(error.is_uncertain());
    assert_eq!(
        engine
            .query(EngineQuery::InventoryIds, deadline(), &token)
            .unwrap_err()
            .fault(),
        EngineFault::Busy
    );
    settle(&engine);
}
#[test]
fn timed_out_constructor_is_retained_and_never_starts_an_unbounded_thread_sequence() {
    let tree = Tree::new();
    let gate = Arc::new(Gate::default());
    let mut bootstrap = tree.bootstrap("stall");
    bootstrap.hooks.gate = Some(Arc::clone(&gate));
    let starts = Arc::clone(&bootstrap.hooks.starts);
    let engine = Arc::new(ReadonlyEngine::new(bootstrap));
    let owned = Arc::clone(&engine);
    let child = std::thread::spawn(move || {
        owned.query(
            EngineQuery::InventoryIds,
            Instant::now() + Duration::from_millis(400),
            &CancellationToken::new(),
        )
    });
    let limit = deadline();
    while !gate.entered.load(Ordering::SeqCst) && Instant::now() < limit {
        std::thread::sleep(Duration::from_millis(1));
    }
    assert!(gate.entered.load(Ordering::SeqCst));
    let error = child.join().unwrap().unwrap_err();
    assert_eq!(error.fault(), EngineFault::Deadline);
    assert!(error.is_uncertain());
    for _ in 0..20 {
        assert_eq!(
            engine
                .query(
                    EngineQuery::InventoryIds,
                    deadline(),
                    &CancellationToken::new()
                )
                .unwrap_err()
                .fault(),
            EngineFault::Busy
        );
    }
    assert_eq!(starts.load(Ordering::SeqCst), 1);
    gate.released.store(true, Ordering::SeqCst);
    settle(&engine);
}
#[test]
fn unreaped_exit_and_fallible_pipe_close_never_become_success() {
    let tree = Tree::new();
    let bootstrap = tree.bootstrap("argv");
    bootstrap.hooks.reap_blocked.store(true, Ordering::SeqCst);
    let blocked = Arc::clone(&bootstrap.hooks.reap_blocked);
    let engine = ReadonlyEngine::new(bootstrap);
    assert!(
        engine
            .query(
                EngineQuery::InventoryIds,
                Instant::now() + Duration::from_millis(50),
                &CancellationToken::new()
            )
            .unwrap_err()
            .is_uncertain()
    );
    blocked.store(false, Ordering::SeqCst);
    settle(&engine);
    let bootstrap = tree.bootstrap("close");
    bootstrap.hooks.close_failed.store(true, Ordering::SeqCst);
    let engine = ReadonlyEngine::new(bootstrap);
    let error = engine
        .query(
            EngineQuery::InventoryIds,
            deadline(),
            &CancellationToken::new(),
        )
        .unwrap_err();
    assert!(error.is_uncertain());
    assert!(error.cleanup_faults().contains(&CleanupFault::StdoutClose));
    assert!(engine.settle_owned(deadline()).is_err());
}
#[test]
fn service_bootstrap_freezes_endpoint_environment_cwd_and_path_resolution() {
    let tree = Tree::new();
    fs::hard_link(program(), tree.root.join("environment")).unwrap();
    let environment = BTreeMap::from([
        (OsString::from("PATH"), tree.root.clone().into_os_string()),
        (
            OsString::from("DOCKER_HOST"),
            OsString::from("unix:///synthetic-endpoint"),
        ),
        (OsString::from("RAW"), OsString::from_vec(vec![255])),
    ]);
    let bootstrap = EngineBootstrap::from_service(
        std::ffi::OsStr::new("environment"),
        environment,
        tree.root.clone(),
    )
    .unwrap();
    let engine = ReadonlyEngine::new(bootstrap);
    assert_eq!(
        engine
            .query(
                EngineQuery::InventoryIds,
                deadline(),
                &CancellationToken::new()
            )
            .unwrap(),
        format!(
            "{}|unix:///synthetic-endpoint|ff|environment",
            tree.root.display()
        )
    );
    settle(&engine);
}
#[test]
fn external_cancellation_during_output_preserves_owned_cleanup() {
    let tree = Tree::new();
    let bootstrap = tree.bootstrap("stream");
    let reads = Arc::clone(&bootstrap.hooks.reads);
    let engine = Arc::new(ReadonlyEngine::new(bootstrap));
    let token = CancellationToken::new();
    let owned = Arc::clone(&engine);
    let external = token.clone();
    let handle =
        std::thread::spawn(move || owned.query(EngineQuery::InventoryIds, deadline(), &external));
    let limit = deadline();
    while reads.load(Ordering::SeqCst) == 0 && Instant::now() < limit {
        std::thread::sleep(Duration::from_millis(1));
    }
    assert!(reads.load(Ordering::SeqCst) > 0);
    let before = Instant::now();
    token.cancel();
    assert_eq!(
        handle.join().unwrap().unwrap_err().fault(),
        EngineFault::Cancelled
    );
    assert!(before.elapsed() < Duration::from_secs(1));
    settle(&engine);
}
#[test]
fn failed_exec_releases_only_after_the_failed_client_constructor_returns() {
    let tree = Tree::new();
    let bootstrap = tree.bootstrap("removed");
    fs::remove_file(tree.root.join("removed")).unwrap();
    let engine = ReadonlyEngine::new(bootstrap);
    assert_eq!(
        engine
            .query(
                EngineQuery::InventoryIds,
                deadline(),
                &CancellationToken::new()
            )
            .unwrap_err()
            .fault(),
        EngineFault::Spawn
    );
    settle(&engine);
}
#[test]
fn preparation_close_uncertainty_fences_queries_before_child_construction() {
    let tree = Tree::new();
    let bootstrap = tree.bootstrap("preparation");
    bootstrap
        .hooks
        .preparation_failed
        .store(true, Ordering::SeqCst);
    let starts = Arc::clone(&bootstrap.hooks.starts);
    let engine = ReadonlyEngine::new(bootstrap);
    let error = engine
        .query(
            EngineQuery::InventoryIds,
            deadline(),
            &CancellationToken::new(),
        )
        .unwrap_err();
    assert!(error.is_uncertain());
    assert!(
        error
            .cleanup_faults()
            .contains(&CleanupFault::HandshakeClose)
    );
    assert_eq!(starts.load(Ordering::SeqCst), 0);
    assert!(engine.settle_owned(deadline()).is_err());
    assert_eq!(
        engine
            .query(
                EngineQuery::InventoryIds,
                deadline(),
                &CancellationToken::new()
            )
            .unwrap_err()
            .fault(),
        EngineFault::Busy
    );
}
