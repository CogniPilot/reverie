//! Real private captures: read admission never settles a sibling or replays a
//! started query. Goal exercises its original stdout-only 500ms purpose.
use super::*;
use crate::{
    captured_client::{
        CallFailure, CapturedOutput, Fault,
        test_hooks::{Gate, Hooks, RunningSibling},
    },
    engine_metadata::EngineBootstrap,
};
use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::atomic::{AtomicUsize, Ordering},
};
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Fixture {
    root: PathBuf,
    engine: Arc<InstalledWorkerEngine>,
    hooks: Hooks,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "readonly-purpose-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let program = root.join("image-refresh");
        fs::hard_link(crate::engine_metadata::tests::program(), &program).unwrap();
        fs::write(root.join("ps.out"), b"fixed-goal-output").unwrap();
        fs::write(root.join("inspect.out"), br#"[{"State":{"Running":true},"NetworkSettings":{"Networks":{"bridge":{"IPAddress":"127.0.0.1"}}}}]"#).unwrap();
        let mut bootstrap =
            EngineBootstrap::from_service(program.as_os_str(), BTreeMap::new(), root.clone())
                .unwrap();
        bootstrap.hooks.gate = Some(Arc::new(Gate::default()));
        let hooks = bootstrap.hooks.clone();
        Self {
            root,
            engine: Arc::new(InstalledWorkerEngine::new(bootstrap)),
            hooks,
        }
    }
    fn sibling(&self) -> RunningSibling {
        RunningSibling::start(
            self.engine.readonly().client,
            self.hooks.gate.clone().unwrap(),
        )
    }
    fn goal(
        &self,
        end: Instant,
        cancel: &crate::captured_client::CancellationToken,
    ) -> std::result::Result<CapturedOutput, CallFailure> {
        self.engine.engine.client.run_goal_inventory(
            vec!["ps".into()],
            end,
            cancel,
            Policy {
                maximum: Duration::from_millis(500),
                maximum_output: 1024 * 1024,
                successful_exit: true,
            },
        )
    }
    fn close(&self) -> std::result::Result<(), EngineError> {
        self.engine.close(end())
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}
pub(crate) fn wait_for_waiter_or_return<T>(
    hooks: &Hooks,
    query: &std::thread::ScopedJoinHandle<'_, T>,
) {
    let end = end();
    while !hooks.admission_waited.load(Ordering::Acquire) && !query.is_finished() {
        assert!(Instant::now() < end, "waiter observed or returned");
        std::thread::sleep(Duration::from_millis(1));
    }
}
fn end() -> Instant {
    Instant::now() + Duration::from_secs(3)
}

#[test]
fn backend_read_waits_for_sibling_then_inspects_once() {
    let fixture = Fixture::new();
    let sibling = fixture.sibling();
    let (sibling, result, before) = std::thread::scope(|scope| {
        let query = scope.spawn(|| inspect_fixed_container_scoped(&fixture.engine, "test-console"));
        wait_for_waiter_or_return(&fixture.hooks, &query);
        let before = fixture.hooks.starts.load(Ordering::Acquire);
        (sibling.release(), query.join().unwrap(), before)
    });
    let starts = fixture.hooks.starts.load(Ordering::Acquire);
    let closed = fixture.close();
    drop(fixture);
    sibling.unwrap();
    closed.unwrap();
    assert_eq!(before, 1);
    assert_eq!(starts, 2, "one sibling and one original inspection");
    assert_eq!(
        result
            .unwrap_or_else(|failure| panic!("{}", failure.error))
            .office_address_data()
            .unwrap()
            .scalar_text()
            .unwrap(),
        "127.0.0.1"
    );
}
#[test]
fn backend_first_stop_before_admission_dispatches_nothing_and_keeps_sibling() {
    let fixture = Fixture::new();
    let sibling = fixture.sibling();
    let result = std::thread::scope(|scope| {
        let query = scope.spawn(|| inspect_fixed_container_scoped(&fixture.engine, "test-console"));
        wait_for_waiter_or_return(&fixture.hooks, &query);
        fixture.engine.expire_stop_for_owned_test();
        query.join().unwrap()
    });
    let starts = fixture.hooks.starts.load(Ordering::Acquire);
    let sibling = sibling.release();
    // The original expired stop is deliberately not renewed. Close is only
    // observed as known after the sibling has itself finalized and released.
    let closed = fixture.close();
    drop(fixture);
    sibling.unwrap();
    closed.unwrap();
    let failure = result.err().unwrap();
    assert!(
        matches!(failure.error, WorkerRecoveryError::Engine(error) if error.fault() == crate::engine_metadata::EngineFault::Cancelled)
    );
    assert!(failure.call.is_none());
    assert_eq!(starts, 1);
}
#[test]
fn backend_started_unknown_retains_original_ticket_and_never_reissues() {
    if crate::test_process::isolate_case(
        "worker_recovery::tests::backend_started_unknown_retains_original_ticket_and_never_reissues",
    ) {
        return;
    }
    let fixture = Fixture::new();
    fixture
        .hooks
        .gate
        .as_ref()
        .unwrap()
        .released
        .store(true, Ordering::Release);
    fixture.hooks.close_failed.store(true, Ordering::Release);
    let failure = inspect_fixed_container_scoped(&fixture.engine, "test-console")
        .err()
        .unwrap();
    let ticket = failure.call.as_ref().unwrap();
    let settled = fixture.engine.engine.client.settle_call(ticket, end());
    let second = inspect_fixed_container_scoped(&fixture.engine, "test-console");
    let starts = fixture.hooks.starts.load(Ordering::Acquire);
    let closed = fixture.close();
    drop(fixture);
    assert!(matches!(failure.error, WorkerRecoveryError::Engine(error) if error.is_uncertain()));
    assert!(settled.is_err() && closed.is_err());
    assert!(second.is_err());
    assert_eq!(starts, 1);
}

#[test]
fn goal_stdout_read_waits_then_issues_one_original_query() {
    let fixture = Fixture::new();
    let sibling = fixture.sibling();
    let (sibling, result, before) = std::thread::scope(|scope| {
        let query = scope.spawn(|| {
            fixture.goal(
                Instant::now() + Duration::from_millis(500),
                &crate::captured_client::CancellationToken::new(),
            )
        });
        wait_for_waiter_or_return(&fixture.hooks, &query);
        let before = fixture.hooks.starts.load(Ordering::Acquire);
        (sibling.release(), query.join().unwrap(), before)
    });
    let starts = fixture.hooks.starts.load(Ordering::Acquire);
    let closed = fixture.close();
    drop(fixture);
    sibling.unwrap();
    closed.unwrap();
    let output = result.unwrap_or_else(|failure| panic!("{:?}", failure.error));
    assert_eq!(before, 1);
    assert_eq!(starts, 2);
    assert_eq!(output.stdout, b"fixed-goal-output");
    assert!(output.stderr.is_empty());
}
#[test]
fn goal_original_deadline_expires_without_dispatch_or_sibling_settlement() {
    let fixture = Fixture::new();
    let sibling = fixture.sibling();
    let result = fixture.goal(
        Instant::now() + Duration::from_millis(60),
        &crate::captured_client::CancellationToken::new(),
    );
    let starts = fixture.hooks.starts.load(Ordering::Acquire);
    let sibling = sibling.release();
    let closed = fixture.close();
    drop(fixture);
    sibling.unwrap();
    closed.unwrap();
    let failure = result.err().unwrap();
    assert_eq!(failure.error.fault, Fault::Deadline);
    assert!(failure.call.is_none() && !failure.error.may_have_started);
    assert_eq!(starts, 1);
}
#[test]
fn goal_started_unknown_keeps_ticket_without_replay() {
    if crate::test_process::isolate_case(
        "worker_recovery::tests::goal_started_unknown_keeps_ticket_without_replay",
    ) {
        return;
    }
    let fixture = Fixture::new();
    fixture
        .hooks
        .gate
        .as_ref()
        .unwrap()
        .released
        .store(true, Ordering::Release);
    fixture.hooks.close_failed.store(true, Ordering::Release);
    let failure = fixture
        .goal(end(), &crate::captured_client::CancellationToken::new())
        .err()
        .unwrap();
    let settled = fixture
        .engine
        .engine
        .client
        .settle_call(failure.call.as_ref().unwrap(), end());
    let second = fixture.goal(end(), &crate::captured_client::CancellationToken::new());
    let starts = fixture.hooks.starts.load(Ordering::Acquire);
    let closed = fixture.close();
    drop(fixture);
    assert!(failure.error.is_uncertain() && settled.is_err() && closed.is_err());
    assert!(second.is_err());
    assert_eq!(starts, 1);
}
