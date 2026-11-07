//! Genuine fixed engine observations and actual owned Rust target processes.
//! No real container or stop signal authority is inferred from these probes.
use super::*;
use reverie_contracts::broker_laptop::LaptopReadError;
use std::process::{Child, Command};
struct Target(Option<Child>);
impl Target {
    fn new(tree: &Tree) -> Self {
        let program = tree.0.join("stall");
        fs::hard_link(crate::engine_metadata::tests::program(), &program).unwrap();
        Self(Some(Command::new(program).spawn().unwrap()))
    }
    fn pid(&self) -> u32 {
        self.0.as_ref().unwrap().id()
    }
    fn stop(&mut self) {
        let mut child = self.0.take().unwrap();
        let killed = child.kill();
        let waited = child.wait();
        assert!(
            killed.is_ok() && waited.is_ok(),
            "own exact target kill/reap"
        );
    }
}
impl Drop for Target {
    fn drop(&mut self) {
        if let Some(mut child) = self.0.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(20)
}
fn row(tree: &Tree, pid: u32, id: Option<serde_json::Value>) {
    let mut row = json!({"Config":{"Labels":{"reverie.worker":"demo","reverie.session":sid().as_str()}},"State":{"Running":true,"Pid":pid}});
    if let Some(id) = id {
        row["Id"] = id;
    }
    fs::write(
        tree.0.join("inspect.out"),
        serde_json::to_vec(&json!([row])).unwrap(),
    )
    .unwrap();
}
fn plan(runtime: &WorkerRuntime, tree: &Tree, storage: &LaunchStorage) -> ObservedCreatePlan {
    runtime
        .prepare_laptop_plan(tree.source(), tree.source(), storage)
        .unwrap()
}

#[test]
fn second_dead_pane_query_uses_original_raw_id_before_canonical_stop_validation() {
    let tree = Tree::new();
    let runtime = tree.controlled_runtime();
    let other = tree.controlled_runtime();
    let storage = runtime
        .resolve_storage(&tree.source(), &sid())
        .unwrap()
        .into_legacy()
        .unwrap();
    let plan = plan(&runtime, &tree, &storage);
    let mut target = Target::new(&tree);
    row(&tree, target.pid(), Some(json!("raw-original-id")));
    let captured = plan
        .inspect_existing(&runtime, deadline())
        .unwrap()
        .unwrap()
        .capture_dead_pane_process(&runtime, &plan, deadline())
        .unwrap();
    assert!(captured.data().canonical_id().is_none());
    let initial = fs::read(tree.0.join("calls.txt")).unwrap();
    assert!(
        captured
            .observe_dead_pane_again(&other, &plan, deadline())
            .is_err()
    );
    assert_eq!(fs::read(tree.0.join("calls.txt")).unwrap(), initial);
    fs::write(tree.0.join("pane.out"), b"1\n").unwrap();
    assert_eq!(
        captured
            .observe_dead_pane_again(&runtime, &plan, deadline())
            .unwrap(),
        ExistingPaneState::Dead
    );
    fs::write(tree.0.join("pane.out"), b"0\n").unwrap();
    assert_eq!(
        captured
            .observe_dead_pane_again(&runtime, &plan, deadline())
            .unwrap(),
        ExistingPaneState::Live
    );
    let calls = fs::read_to_string(tree.0.join("calls.txt")).unwrap();
    assert_eq!(calls.lines().count(), 3);
    for call in calls.lines().skip(1) {
        let args = call.split('\0').collect::<Vec<_>>();
        assert_eq!(args[9], "raw-original-id");
        assert_eq!(
            &args[args.len() - 5..],
            ["display-message", "-p", "-t", "office", "#{pane_dead}"]
        );
    }
    row(&tree, target.pid(), Some(json!(null)));
    let invalid = plan
        .inspect_existing(&runtime, deadline())
        .unwrap()
        .unwrap()
        .capture_dead_pane_process(&runtime, &plan, deadline())
        .unwrap();
    let calls = fs::read(tree.0.join("calls.txt")).unwrap();
    assert!(matches!(
        invalid.observe_dead_pane_again(&runtime, &plan, deadline()),
        Err(ExistingObservationError::Data(LaptopReadError::Structure))
    ));
    assert_eq!(fs::read(tree.0.join("calls.txt")).unwrap(), calls);
    target.stop();
    storage.close(end()).unwrap();
    runtime.close(end()).unwrap();
    other.close(end()).unwrap();
}

#[test]
fn actual_dead_and_running_capture_keep_kernel_incarnation_without_an_extra_engine_query() {
    let tree = Tree::new();
    let runtime = tree.controlled_runtime();
    let storage = runtime
        .resolve_storage(&tree.source(), &sid())
        .unwrap()
        .into_legacy()
        .unwrap();
    let plan = plan(&runtime, &tree, &storage);
    let mut target = Target::new(&tree);
    let pid = target.pid();
    let expected = reverie_contracts::kernel_accounting::process_start(
        &fs::read_to_string(format!("/proc/{pid}/stat")).unwrap(),
    )
    .unwrap();
    row(&tree, pid, Some(json!(null)));
    let observed = plan
        .inspect_existing(&runtime, deadline())
        .unwrap()
        .unwrap();
    let captured = observed
        .capture_dead_pane_process(&runtime, &plan, deadline())
        .unwrap();
    captured.assert_storage_owner(&runtime, &storage).unwrap();
    assert_eq!(captured.pid().as_str(), pid.to_string());
    assert_eq!(captured.start(), expected);
    assert_eq!(captured.name().as_str(), plan.arguments().name());
    assert_eq!(captured.session(), plan.session());
    assert_eq!(
        worker_config::encode_config(captured.source_configuration()),
        worker_config::encode_config(plan.source())
    );
    assert!(
        captured.data().canonical_id().is_none(),
        "dead-pane source delays Id-type check"
    );
    row(&tree, pid, Some(json!("a".repeat(64))));
    let observed = plan
        .inspect_existing(&runtime, deadline())
        .unwrap()
        .unwrap();
    let replacement = observed
        .capture_running_replacement_process(&runtime, &plan, deadline())
        .unwrap();
    replacement
        .assert_storage_owner(&runtime, &storage)
        .unwrap();
    assert_eq!(replacement.start(), expected);
    let count = fs::read_to_string(tree.0.join("calls.txt"))
        .unwrap()
        .lines()
        .count();
    target.stop();
    storage.close(end()).unwrap();
    let other_storage = runtime
        .resolve_storage(&tree.source(), &sid())
        .unwrap()
        .into_legacy()
        .unwrap();
    assert!(
        replacement
            .assert_storage_owner(&runtime, &other_storage)
            .is_err(),
        "same paths cannot recreate original resource generation"
    );
    other_storage.close(end()).unwrap();
    runtime.close(end()).unwrap();
    assert_eq!(
        count, 2,
        "both _pid captures add no inspect/re-resolution query"
    );
}

#[test]
fn missing_or_noncanonical_id_refuses_at_its_original_distinct_capture_phase_before_proc() {
    let tree = Tree::new();
    let runtime = tree.controlled_runtime();
    let storage = runtime
        .resolve_storage(&tree.source(), &sid())
        .unwrap()
        .into_legacy()
        .unwrap();
    let plan = plan(&runtime, &tree, &storage);
    // A nonexistent PID makes any unintended earlier kernel read observable as
    // Kernel error instead of the required first structural/identity refusal.
    row(&tree, u32::MAX, None);
    let observed = plan
        .inspect_existing(&runtime, deadline())
        .unwrap()
        .unwrap();
    let missing = observed
        .capture_dead_pane_process(&runtime, &plan, deadline())
        .err()
        .unwrap();
    assert!(matches!(
        missing.cause(),
        ExistingObservationError::Data(LaptopReadError::Structure)
    ));
    assert!(missing.observation_data().canonical_id().is_none());
    row(&tree, u32::MAX, Some(json!(null)));
    let observed = plan
        .inspect_existing(&runtime, deadline())
        .unwrap()
        .unwrap();
    let invalid = observed
        .capture_running_replacement_process(&runtime, &plan, deadline())
        .err()
        .unwrap();
    assert!(matches!(
        invalid.cause(),
        ExistingObservationError::Data(LaptopReadError::Process)
    ));
    storage.close(end()).unwrap();
    runtime.close(end()).unwrap();
}

#[test]
fn exited_owned_target_cannot_mint_incarnation_and_wrong_plan_refuses_before_proc() {
    let tree = Tree::new();
    let runtime = tree.controlled_runtime();
    let storage = runtime
        .resolve_storage(&tree.source(), &sid())
        .unwrap()
        .into_legacy()
        .unwrap();
    let first = plan(&runtime, &tree, &storage);
    let second = plan(&runtime, &tree, &storage);
    let mut target = Target::new(&tree);
    let pid = target.pid();
    row(&tree, pid, Some(json!("a".repeat(64))));
    let observed = first
        .inspect_existing(&runtime, deadline())
        .unwrap()
        .unwrap();
    target.stop();
    let failure = observed
        .capture_running_replacement_process(&runtime, &first, deadline())
        .err()
        .unwrap();
    assert!(matches!(
        failure.cause(),
        ExistingObservationError::Kernel(_)
    ));
    let observed = first
        .inspect_existing(&runtime, deadline())
        .unwrap()
        .unwrap();
    let wrong = observed
        .capture_dead_pane_process(&runtime, &second, deadline())
        .err()
        .unwrap();
    assert!(matches!(wrong.cause(), ExistingObservationError::Origin));
    storage.close(end()).unwrap();
    runtime.close(end()).unwrap();
}
