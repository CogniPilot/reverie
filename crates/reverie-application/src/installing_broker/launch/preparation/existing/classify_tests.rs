use super::super::super::tests::{broker_configuration, end, finish_claimed};
use super::*;
use crate::reservation_gate::tests::Tree;
use std::{
    fs,
    process::{Child, Command},
};
pub(super) const SID: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
pub(super) fn broker(tree: &Tree) -> InstallingBroker {
    let mut raw: serde_json::Value = serde_json::from_slice(&tree.raw).unwrap();
    raw.as_object_mut().unwrap().remove("resourceReservations");
    raw["budgetMode"] = serde_json::json!("admission");
    raw["memoryMiB"] = serde_json::json!(512);
    let broker = broker_configuration(tree, &raw);
    tree.write("company.json", br#"{"employees":[]}"#);
    broker
}
pub(super) fn inspection<'a>(
    tree: &Tree,
    broker: &'a InstallingBroker,
    pid: Option<u32>,
    completed: bool,
) -> InspectedWorkerLaunch<'a> {
    inspection_with_client(tree, broker, pid, completed).1
}
pub(super) fn inspection_with_client<'a>(
    tree: &Tree,
    broker: &'a InstallingBroker,
    pid: Option<u32>,
    completed: bool,
) -> (std::os::unix::net::UnixStream, InspectedWorkerLaunch<'a>) {
    let (client, socket) = super::super::super::super::tests::incoming_as(broker, b'J', SID, false);
    let WorkerConnectionDispatch::Launch(received) =
        broker.accept_worker_connection(socket).unwrap()
    else {
        panic!("actual J");
    };
    let observed = PreparingWorkerLaunch::enter(received.begin_ordinary().unwrap())
        .unwrap_or_else(|e| panic!("{e}"))
        .claim()
        .unwrap()
        .observe()
        .unwrap();
    let policy = observed.plan.arguments().policy_digest().to_hex();
    tree.write("inspect.out", &serde_json::to_vec(&serde_json::json!([{
        "Id":"a".repeat(64),"Config":{"Labels":{"reverie.worker":"test","reverie.session":SID,"reverie.worker-policy":policy}},
        "State":{"Running":true,"Pid":pid}
    }])).unwrap());
    let directory = tree.root.join("state").join(SID);
    fs::write(
        directory.join("runtime.json"),
        br#"{"exit":"original.exit"}"#,
    )
    .unwrap();
    if completed {
        let launch = observed
            .claimed
            .storage
            .as_ref()
            .unwrap()
            .paths()
            .home()
            .join(".reverie-launch");
        fs::create_dir_all(&launch).unwrap();
        fs::write(launch.join("original.exit"), b"0").unwrap();
    }
    (client, observed.inspect(end()).unwrap())
}
fn finish_failure(failure: Box<PreparationFailure<'_>>, broker: &InstallingBroker) {
    let failure = *failure;
    let claimed = ClaimedWorkerLaunch {
        preparing: failure.preparing,
        storage: failure.storage,
        active: failure.active,
        observed: failure.observed.unwrap(),
        lifecycle: broker.installed.lifecycle().unwrap(),
    };
    finish_claimed(claimed);
}
struct Process(Child);
impl Process {
    fn new(tree: &Tree) -> Self {
        let program = tree.root.join("stall");
        fs::hard_link(crate::test_process::engine_program(), &program).unwrap();
        Self(Command::new(program).spawn().unwrap())
    }
    fn stop(&mut self) {
        self.0.kill().unwrap();
        self.0.wait().unwrap();
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn live_existing_pane_reuses_whole_original_scope_without_pid_or_new_creation_budget() {
    let tree = Tree::new();
    let broker = broker(&tree);
    let inspected = inspection(&tree, &broker, None, false);
    tree.write("pane.out", "\u{1c}0\u{85}\n".as_bytes());
    let ClassifiedWorkerLaunch::Reuse(reuse) = inspected.classify_existing().unwrap() else {
        panic!("genuine live reuse");
    };
    assert!(!reuse.receipt().unwrap().exists());
    assert!(broker.installed.laptops.try_lock().is_err());
    assert!(reuse.inspected.observed.claimed.active.is_some());
    let calls = fs::read_to_string(tree.root.join("calls.txt")).unwrap();
    assert_eq!(
        calls
            .lines()
            .filter(|line| line.starts_with("exec\0"))
            .count(),
        1
    );
    assert!(calls.lines().last().unwrap().ends_with("#{pane_dead}"));
    finish_claimed(reuse.inspected.observed.claimed);
    broker.close_command_telemetry(end()).unwrap();
}

#[test]
fn attach_only_rechecks_live_pane_and_keeps_real_claim_when_second_pane_has_exited() {
    for second in [b"1\n".as_slice(), b"invalid\n".as_slice()] {
        let tree = Tree::new();
        let broker = broker(&tree);
        let inspected = inspection(&tree, &broker, None, false);
        // The existing accepted request is ordinary; build a real attach J rather
        // than replacing a request/configuration inside an admitted owner.
        finish_claimed(inspected.observed.claimed);
        let (_client, socket) =
            super::super::super::super::tests::incoming_as(&broker, b'J', SID, true);
        let WorkerConnectionDispatch::Launch(received) =
            broker.accept_worker_connection(socket).unwrap()
        else {
            panic!("J");
        };
        // incoming_as's final bool is attachOnly, verified by actual parsed data.
        assert_eq!(received.request().attach_only(), Some(true));
        let inspected = received.begin_ordinary().unwrap().prepare_prefix().unwrap();
        tree.write("pane.out", b"0\n");
        tree.write("pane.next", second);
        let failure = inspected.classify_existing().err().unwrap();
        assert_eq!(
            failure.cause.to_string(),
            "The existing laptop process has exited"
        );
        assert!(failure.storage.is_some() && failure.active.is_some());
        finish_failure(failure, &broker);
        broker.close_command_telemetry(end()).unwrap();
    }
}

#[test]
fn completed_running_receipt_captures_original_real_process_without_pane_or_capacity_credit() {
    let tree = Tree::new();
    let mut child = Process::new(&tree);
    let broker = broker(&tree);
    let inspected = inspection(&tree, &broker, Some(child.0.id()), true);
    let ClassifiedWorkerLaunch::Cold(cold) = inspected.classify_existing().unwrap() else {
        panic!("replacement");
    };
    assert!(!cold.has_dead_inner());
    assert_eq!(
        cold.previous_process().unwrap().pid().as_str(),
        child.0.id().to_string()
    );
    let calls = fs::read_to_string(tree.root.join("calls.txt")).unwrap();
    assert!(!calls.lines().any(|line| line.starts_with("exec\0")));
    assert!(broker.installed.laptops.try_lock().is_err());
    child.stop();
    finish_claimed(cold.inspected.observed.claimed);
    broker.close_command_telemetry(end()).unwrap();
}

#[test]
fn actual_dead_pane_captures_original_process_and_never_dispatches_stop() {
    let tree = Tree::new();
    let mut child = Process::new(&tree);
    let broker = broker(&tree);
    let inspected = inspection(&tree, &broker, Some(child.0.id()), false);
    tree.write("pane.out", b"1\n");
    let ClassifiedWorkerLaunch::Cold(cold) = inspected.classify_existing().unwrap() else {
        panic!("dead replacement");
    };
    assert!(cold.has_dead_inner());
    assert!(cold.previous_process().is_some());
    let calls = fs::read_to_string(tree.root.join("calls.txt")).unwrap();
    assert_eq!(
        calls
            .lines()
            .filter(|line| line.starts_with("exec\0"))
            .count(),
        1
    );
    assert!(
        !calls
            .lines()
            .any(|line| line.starts_with("stop\0") || line.starts_with("rm\0"))
    );
    child.stop();
    finish_claimed(cold.inspected.observed.claimed);
    broker.close_command_telemetry(end()).unwrap();
}

#[test]
fn malformed_pane_refuses_before_missing_pid_and_keeps_real_scope_and_resource() {
    let tree = Tree::new();
    let broker = broker(&tree);
    let inspected = inspection(&tree, &broker, None, false);
    tree.write("pane.out", b"other\n");
    let failure = inspected.classify_existing().err().unwrap();
    assert_eq!(
        failure.cause.to_string(),
        "Existing laptop pane state is unavailable; no replacement was started"
    );
    assert!(failure.storage.is_some() && failure.active.is_some());
    finish_failure(failure, &broker);
    broker.close_command_telemetry(end()).unwrap();
}

#[test]
fn attach_dead_pane_requires_original_process_identity_before_attach_unavailable_refusal() {
    let tree = Tree::new();
    let broker = broker(&tree);
    let initial = inspection(&tree, &broker, None, false);
    finish_claimed(initial.observed.claimed);
    let (_client, socket) =
        super::super::super::super::tests::incoming_as(&broker, b'J', SID, true);
    let WorkerConnectionDispatch::Launch(received) =
        broker.accept_worker_connection(socket).unwrap()
    else {
        panic!("actual J");
    };
    let inspected = received.begin_ordinary().unwrap().prepare_prefix().unwrap();
    tree.write("pane.out", b"1\n");
    let failure = inspected.classify_existing().err().unwrap();
    let PreparationError::ExistingCapture(capture) = &failure.cause else {
        panic!("process capture must precede attach refusal");
    };
    assert!(capture.observation_data().running().unwrap());
    assert!(matches!(capture.cause(), ExistingObservationError::Data(_)));
    assert!(failure.storage.is_some() && failure.active.is_some());
    finish_failure(failure, &broker);
    broker.close_command_telemetry(end()).unwrap();
}

#[test]
fn actual_cancellation_before_pane_never_dispatches_replacement_and_retains_same_scope() {
    let tree = Tree::new();
    let broker = broker(&tree);
    let inspected = inspection(&tree, &broker, None, false);
    tree.write("pane.out", b"0\n");
    let before = fs::read(tree.root.join("calls.txt")).unwrap();
    broker.storage.runtime.request_stop();
    let failure = inspected.classify_existing().err().unwrap();
    assert!(matches!(
        failure.cause,
        PreparationError::ExistingHost(ExistingObservationError::Engine(_))
    ));
    assert_eq!(fs::read(tree.root.join("calls.txt")).unwrap(), before);
    assert!(failure.storage.is_some() && failure.active.is_some());
    finish_failure(failure, &broker);
    broker.close_command_telemetry(end()).unwrap();
}

#[test]
fn absent_and_stopped_observations_reach_real_initial_budget_without_receipt_or_pane_reads() {
    for stopped in [false, true] {
        let tree = Tree::new();
        let broker = broker(&tree);
        tree.write("inspect.out", if stopped { br#"[{"Config":{"Labels":{"reverie.worker":"test","reverie.session":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"}},"State":{"Running":false}}]"# } else { b"not-json" });
        tree.write("inspect.out.status", if stopped { b"0" } else { b"7" });
        let (_client, socket) =
            super::super::super::super::tests::incoming_as(&broker, b'J', SID, false);
        let WorkerConnectionDispatch::Launch(received) =
            broker.accept_worker_connection(socket).unwrap()
        else {
            panic!("actual J");
        };
        let inspected = received.begin_ordinary().unwrap().prepare_prefix().unwrap();
        let ClassifiedWorkerLaunch::Cold(cold) = inspected.classify_existing().unwrap() else {
            panic!("cold");
        };
        assert!(if stopped {
            matches!(cold.target(), ExistingColdTarget::Stopped(_))
        } else {
            matches!(cold.target(), ExistingColdTarget::Absent)
        });
        assert!(cold.previous_process().is_none());
        let trace = fs::read_to_string(tree.root.join("calls.txt")).unwrap();
        assert!(
            trace.lines().last().unwrap().starts_with("ps\0"),
            "actual initial creation budget executes"
        );
        assert!(!trace.lines().any(|line| line.starts_with("exec\0")));
        assert!(
            broker.installed.laptops.try_lock().is_err(),
            "budget borrowed the SAME held mutex"
        );
        finish_claimed(cold.inspected.observed.claimed);
        broker.close_command_telemetry(end()).unwrap();
    }
}
