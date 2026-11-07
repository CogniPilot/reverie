//! Crossings of the actual shared constructor/query slot, never another cap.
use super::*;
use crate::{
    captured_client::{CancellationToken, Policy},
    engine_metadata::{EngineFault, EngineQuery},
};
struct Query {
    token: CancellationToken,
    task: Option<
        std::thread::JoinHandle<std::result::Result<String, crate::engine_metadata::EngineError>>,
    >,
    root: PathBuf,
}
impl Query {
    fn start(fixture: &Fixture) -> Self {
        let token = CancellationToken::new();
        let cancellation = token.clone();
        let runtime = fixture.runtime().clone();
        let task = std::thread::spawn(move || {
            runtime.readonly().query(
                EngineQuery::InventoryIds,
                Instant::now() + Duration::from_secs(20),
                &cancellation,
            )
        });
        let query = Self {
            token,
            task: Some(task),
            root: fixture.root.clone(),
        };
        wait(|| query.root.join("metadata-entered").is_file());
        query
    }
    fn release(&self) {
        fs::write(
            self.root.join("release-metadata"),
            b"natural query completion",
        )
        .unwrap();
    }
    fn finish(mut self) {
        assert_eq!(self.task.take().unwrap().join().unwrap().unwrap(), "");
    }
}
impl Drop for Query {
    fn drop(&mut self) {
        self.token.cancel();
        if let Some(task) = self.task.take() {
            let _ = task.join();
        }
    }
}
struct Release(Arc<crate::captured_client::test_hooks::Gate>);
impl Drop for Release {
    fn drop(&mut self) {
        self.0.released.store(true, Ordering::Release);
    }
}
fn isolated(name: &str) -> bool {
    crate::test_process::isolate_case(&format!("worker_laptop::tests::viewer::admission::{name}"))
}
fn gate() -> Arc<crate::captured_client::test_hooks::Gate> {
    Arc::default()
}
fn query_count(fixture: &Fixture) -> usize {
    fs::read_to_string(fixture.root.join("trace"))
        .unwrap()
        .lines()
        .filter(|line| *line == "ps\0-aq\0--no-trunc")
        .count()
}
#[test]
fn permanently_closed_same_capture_refuses_viewer_before_any_native_constructor() {
    if isolated("permanently_closed_same_capture_refuses_viewer_before_any_native_constructor") {
        return;
    }
    let fixture = Fixture::new("created-viewer-echo");
    let (workflow, _, released) = released(&fixture);
    fixture.runtime().readonly().close(end()).unwrap();
    assert!(
        !fixture.runtime().cancellation().is_cancelled(),
        "shared close, not global cancellation, is decisive"
    );
    assert!(matches!(
        fixture
            .runtime()
            .start_laptop_viewer_session(&released, end())
            .unwrap(),
        ViewerStart::Retained
    ));
    assert!(!fixture.root.join("viewer-ready").exists());
    assert!(
        matches!(workflow.failure().unwrap().as_deref(),Some(LaptopError::Engine(error)) if error.fault()==EngineFault::Cancelled)
    );
    assert!(fixture.runtime().close(end()).is_err());
}
#[test]
fn pending_query_blocks_viewer_admission_and_pending_viewer_returns_query_busy_without_cancellation()
 {
    if isolated(
        "pending_query_blocks_viewer_admission_and_pending_viewer_returns_query_busy_without_cancellation",
    ) {
        return;
    }
    let fixture = Fixture::new("created-viewer-metadata");
    let (_, _, released) = released(&fixture);
    let query = Query::start(&fixture);
    let busy = gate();
    let constructor = gate();
    let _release = Release(constructor.clone());
    let runtime = fixture.runtime().clone();
    let pause = constructor.clone();
    let seen = busy.clone();
    let viewer = std::thread::spawn(move || {
        super::super::super::viewer::test_hooks::observe_busy(seen);
        super::super::super::viewer::test_hooks::next_constructor(pause);
        runtime.start_laptop_viewer_session(&released, Instant::now() + Duration::from_secs(20))
    });
    wait(|| busy.entered.load(Ordering::Acquire));
    assert!(!constructor.entered.load(Ordering::Acquire));
    assert!(!fixture.root.join("viewer-ready").exists());
    assert_eq!(query_count(&fixture), 1);
    query.release();
    query.finish();
    wait(|| constructor.entered.load(Ordering::Acquire));
    let error = fixture
        .runtime()
        .readonly()
        .query(EngineQuery::InventoryIds, end(), &CancellationToken::new())
        .unwrap_err();
    assert_eq!(error.fault(), EngineFault::Busy);
    assert_eq!(query_count(&fixture), 1);
    constructor.released.store(true, Ordering::Release);
    let ViewerStart::Started(viewer) = viewer.join().unwrap().unwrap() else {
        panic!("same actual constructor survived Busy query")
    };
    wait(|| fixture.root.join("viewer-ready").is_file());
    fixture
        .runtime()
        .close_laptop_viewer(&viewer, end())
        .unwrap();
}
#[test]
fn closing_racing_late_constructor_seals_handoff_and_never_renews_original_close_budget() {
    if isolated(
        "closing_racing_late_constructor_seals_handoff_and_never_renews_original_close_budget",
    ) {
        return;
    }
    let fixture = Fixture::new("created-viewer-exit");
    let (workflow, _, released) = released(&fixture);
    let constructor = gate();
    let _release = Release(constructor.clone());
    let pause = constructor.clone();
    let runtime = fixture.runtime().clone();
    let viewer = std::thread::spawn(move || {
        super::super::super::viewer::test_hooks::next_constructor(pause);
        runtime.start_laptop_viewer_session(&released, Instant::now() + Duration::from_secs(20))
    });
    wait(|| constructor.entered.load(Ordering::Acquire));
    assert!(
        fixture
            .runtime()
            .readonly()
            .close(Instant::now() + Duration::from_millis(50))
            .is_err()
    );
    assert!(!fixture.runtime().cancellation().is_cancelled());
    constructor.released.store(true, Ordering::Release);
    assert!(matches!(
        viewer.join().unwrap().unwrap(),
        ViewerStart::Retained
    ));
    let job = workflow
        .record
        .lock()
        .unwrap()
        .viewer
        .as_ref()
        .unwrap()
        .clone();
    assert!(
        fixture.runtime().readonly().settle_owned(end()).is_err(),
        "fresh caller budget cannot reset the actual constructor close plan"
    );
    wait(|| job.status().unwrap() == Some(7));
    assert_eq!(job.native_counts(), (1, 0));
    // Checked owning test finalization AFTER product refusal, not a service ACK.
    job.test_reap_exited().unwrap();
    assert!(fixture.runtime().close(end()).is_err());
}
#[test]
fn old_viewer_settlement_cannot_cancel_or_clear_a_new_actual_query() {
    if isolated("old_viewer_settlement_cannot_cancel_or_clear_a_new_actual_query") {
        return;
    }
    let fixture = Fixture::new("created-viewer-metadata");
    let (workflow, _, released) = released(&fixture);
    let viewer = start(&fixture, &released);
    let query = Query::start(&fixture);
    let job = workflow
        .record
        .lock()
        .unwrap()
        .viewer
        .as_ref()
        .unwrap()
        .clone();
    fixture
        .runtime()
        .installed_engine()
        .engine
        .client
        .settle_viewer(&job, end())
        .unwrap();
    fixture
        .runtime()
        .installed_engine()
        .engine
        .client
        .require_viewer_released(&job)
        .unwrap();
    assert!(!query.task.as_ref().unwrap().is_finished());
    assert_eq!(job.status().unwrap(), Some(-15));
    query.release();
    query.finish();
    assert_eq!(query_count(&fixture), 1);
    fixture
        .runtime()
        .close_laptop_viewer(&viewer, end())
        .unwrap();
}
#[test]
fn old_query_settlement_cannot_clear_the_actual_pending_viewer_variant() {
    if isolated("old_query_settlement_cannot_clear_the_actual_pending_viewer_variant") {
        return;
    }
    let fixture = Fixture::new("created-viewer-metadata");
    let (_, _, released) = released(&fixture);
    let token = CancellationToken::new();
    let cancellation = token.clone();
    let client = fixture.runtime().installed_engine().engine.client.clone();
    let running = client.clone();
    let task = std::thread::spawn(move || {
        running.run_scoped(
            vec!["ps".into(), "-aq".into(), "--no-trunc".into()],
            Instant::now() + Duration::from_secs(20),
            &cancellation,
            Policy {
                maximum: Duration::from_secs(20),
                maximum_output: 4 * 1024 * 1024,
                successful_exit: true,
            },
        )
    });
    wait(|| fixture.root.join("metadata-entered").is_file());
    token.cancel();
    let failure = task.join().unwrap().err().unwrap();
    let old = failure.call.unwrap();
    client.settle_call(&old, end()).unwrap();
    let constructor = gate();
    let _release = Release(constructor.clone());
    let pause = constructor.clone();
    let runtime = fixture.runtime().clone();
    let viewer = std::thread::spawn(move || {
        super::super::super::viewer::test_hooks::next_constructor(pause);
        runtime.start_laptop_viewer_session(&released, Instant::now() + Duration::from_secs(20))
    });
    wait(|| constructor.entered.load(Ordering::Acquire));
    client.settle_call(&old, end()).unwrap();
    let error = fixture
        .runtime()
        .readonly()
        .query(EngineQuery::InventoryIds, end(), &CancellationToken::new())
        .unwrap_err();
    assert_eq!(error.fault(), EngineFault::Busy);
    assert_eq!(query_count(&fixture), 1);
    constructor.released.store(true, Ordering::Release);
    let ViewerStart::Started(viewer) = viewer.join().unwrap().unwrap() else {
        panic!("same viewer constructor retained")
    };
    fixture
        .runtime()
        .close_laptop_viewer(&viewer, end())
        .unwrap();
}
#[test]
fn consumed_close_uncertainty_is_refused_not_complete_and_drop_retains_actual_origin() {
    if isolated("consumed_close_uncertainty_is_refused_not_complete_and_drop_retains_actual_origin")
    {
        return;
    }
    let fixture = Fixture::employee("created-viewer-echo");
    let weak = Arc::downgrade(fixture.runtime().installed_engine());
    let (workflow, _, released) = released(&fixture);
    super::super::super::viewer::test_hooks::refuse_next_input_close();
    assert!(matches!(
        fixture
            .runtime()
            .start_laptop_viewer_session(&released, end())
            .unwrap(),
        ViewerStart::Retained
    ));
    let client = fixture.runtime().installed_engine().engine.client.clone();
    assert!(
        matches!(
            client.shutdown(end()),
            reverie_core::shutdown::ShutdownStatus::Refused(_)
        ),
        "consumed descriptor uncertainty is not a known live handle, and cannot become Complete"
    );
    assert!(fixture.runtime().close(end()).is_err());
    drop(client);
    drop(released);
    drop(workflow);
    drop(fixture);
    assert!(
        weak.upgrade().is_some(),
        "actual created/storage/Office owners survive abandonment"
    );
}
