use super::*;
use crate::{reservation_gate::tests::Tree, worker_validation::load_owner_config};
use reverie_host::{
    engine_metadata::EngineBootstrap, installed_worker_engine::InstalledWorkerEngine,
};
use serde_json::Value;
use std::{collections::BTreeMap, fs, time::Duration};
use std::{os::unix::fs::PermissionsExt, path::PathBuf};
fn enabled(tree: &Tree) -> crate::worker_validation::ValidatedWorkerSnapshot {
    let mut raw: Value =
        serde_json::from_slice(&fs::read(tree.root.join("worker.json")).unwrap()).unwrap();
    raw["commandTelemetry"] = serde_json::json!({"enabled":true,"keys":["shell"]});
    tree.write("worker.json", &serde_json::to_vec(&raw).unwrap());
    load_owner_config(&tree.root.join("worker.json")).unwrap()
}
fn runtime(
    tree: &Tree,
    snapshot: &crate::worker_validation::ValidatedWorkerSnapshot,
    mode: &str,
) -> WorkerRuntime {
    let path = tree.root.join(mode);
    fs::hard_link(crate::test_process::engine_program(), &path).unwrap();
    let bootstrap =
        EngineBootstrap::from_service(path.as_os_str(), BTreeMap::new(), tree.root.clone())
            .unwrap();
    WorkerRuntime::new(
        InstalledWorkerEngine::new(bootstrap),
        snapshot.envelope().base(),
    )
}
#[test]
fn telemetry_native_refusal_precedes_gate_marker_reads_and_retains_same_runtime() {
    let tree = Tree::new();
    let snapshot = enabled(&tree);
    let runtime = runtime(&tree, &snapshot, "command-telemetry");
    tree.write(
        "state/resource-reservation-control.json",
        b"malformed marker",
    );
    fs::set_permissions(tree.root.join("state"), fs::Permissions::from_mode(0o755)).unwrap();
    let mut failure = InstallingBroker::new(snapshot, runtime).err().unwrap();
    assert!(matches!(
        failure.cause(),
        BrokerBootstrapCause::Telemetry(_)
    ));
    assert_eq!(failure.code(), "TELEMETRY_BOUNDARY_REFUSED");
    assert!(
        !tree.root.join("calls.txt").exists(),
        "state refusal precedes real inventory"
    );
    failure
        .close(Instant::now() + Duration::from_secs(2))
        .unwrap();
}
#[test]
fn actual_enabled_inventory_and_sink_complete_before_gate_failure() {
    let tree = Tree::new();
    let snapshot = enabled(&tree);
    let runtime = runtime(&tree, &snapshot, "command-telemetry");
    tree.write("ps.out", b"");
    tree.write(
        "state/resource-reservation-control.json",
        b"malformed marker",
    );
    let mut failure = InstallingBroker::new(snapshot, runtime).err().unwrap();
    assert!(matches!(failure.cause(), BrokerBootstrapCause::Gate(_)));
    assert!(
        failure
            .owner
            .as_ref()
            .unwrap()
            .telemetry
            .as_ref()
            .unwrap()
            .enabled()
    );
    assert_eq!(
        fs::read(tree.root.join("calls.txt")).unwrap(),
        b"ps\0--all\0--filter\0label=reverie.worker\0--format\0{{.ID}}\n"
    );
    assert!(tree.root.join("state/command-telemetry").is_dir());
    failure
        .close(Instant::now() + Duration::from_secs(2))
        .unwrap();
}
struct Pending {
    root: PathBuf,
    task: Option<std::thread::JoinHandle<Result<InstallingBroker, Box<BrokerBootstrapFailure>>>>,
}
impl Pending {
    fn wait(&self, name: &str) {
        let until = Instant::now() + Duration::from_secs(3);
        while !self.root.join(name).exists() {
            assert!(Instant::now() < until, "actual owned process stage {name}");
            std::thread::sleep(Duration::from_millis(1));
        }
    }
}
impl Drop for Pending {
    fn drop(&mut self) {
        let _ = fs::write(self.root.join("release-pipe-owner"), b"owned release");
        if let Some(task) = self.task.take() {
            let _ = task.join();
        }
    }
}
#[test]
fn failed_startup_retains_actual_pending_pipe_owner_until_checked_same_runtime_settlement() {
    let tree = Tree::new();
    let snapshot = enabled(&tree);
    let runtime = runtime(&tree, &snapshot, "telemetry-bootstrap-pending");
    let cancellation = runtime.cancellation();
    let task = std::thread::spawn(move || InstallingBroker::new(snapshot, runtime));
    let mut pending = Pending {
        root: tree.root.clone(),
        task: Some(task),
    };
    pending.wait("query-started");
    cancellation.cancel();
    let mut failure = pending.task.take().unwrap().join().unwrap().err().unwrap();
    assert!(matches!(
        failure.cause(),
        BrokerBootstrapCause::Telemetry(_)
    ));
    let original = failure.code();
    let error = failure
        .close(Instant::now() + Duration::from_millis(20))
        .unwrap_err();
    assert!(error.runtime_error().is_some());
    let first_stop = failure
        .owner
        .as_ref()
        .unwrap()
        .runtime
        .stop_deadline()
        .unwrap();
    fs::write(tree.root.join("release-pipe-owner"), b"owned release").unwrap();
    failure
        .close(Instant::now() + Duration::from_secs(2))
        .unwrap();
    assert_eq!(
        failure.owner.as_ref().unwrap().runtime.stop_deadline(),
        Some(first_stop)
    );
    assert_eq!(
        failure.code(),
        original,
        "settlement is no constructor retry/success upgrade"
    );
    assert_eq!(
        fs::read(tree.root.join("calls.txt"))
            .unwrap()
            .split_inclusive(|&byte| byte == b'\n')
            .count(),
        1,
        "one actual fixed inventory dispatch"
    );
}
#[test]
fn ignored_unsettled_constructor_failure_keeps_original_owner_and_publishes_same_stop() {
    let tree = Tree::new();
    let snapshot = enabled(&tree);
    let runtime = runtime(&tree, &snapshot, "command-telemetry");
    let cancellation = runtime.cancellation();
    fs::set_permissions(tree.root.join("state"), fs::Permissions::from_mode(0o755)).unwrap();
    let failure = InstallingBroker::new(snapshot, runtime).err().unwrap();
    let weak = Arc::downgrade(&failure.owner.as_ref().unwrap().installed);
    assert!(!cancellation.is_cancelled());
    drop(failure);
    assert!(cancellation.is_cancelled());
    assert!(
        weak.upgrade().is_some(),
        "actual snapshot/runtime retained; Drop is not settlement"
    );
}
#[test]
fn actual_installing_broker_t_operation_uses_mandatory_collector_and_tracks_local_close() {
    use std::{
        io::{Read, Write},
        os::unix::net::{UnixListener, UnixStream},
    };
    let tree = Tree::new();
    let mut raw: Value = serde_json::from_slice(&tree.raw).unwrap();
    raw.as_object_mut().unwrap().remove("resourceReservations");
    tree.write("worker.json", &serde_json::to_vec(&raw).unwrap());
    fs::remove_file(tree.root.join("state/resource-reservation-control.json")).unwrap();
    let snapshot = load_owner_config(&tree.root.join("worker.json")).unwrap();
    let runtime = runtime(&tree, &snapshot, "command-telemetry");
    let cancelled = runtime.cancellation();
    let broker = InstallingBroker::new(snapshot, runtime).unwrap();
    assert!(!broker.command_telemetry().enabled());
    let path = tree.root.join("t.sock");
    let listener = UnixListener::bind(&path).unwrap();
    let mut client = UnixStream::connect(path).unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let (server, _) = listener.accept().unwrap();
    std::thread::scope(|scope| {
        let task = scope.spawn(|| broker.handle_command_failure_report(server));
        let raw = br#"{"v":1,"action":"command-failures","employee_ids":[]}"#;
        client
            .write_all(
                &reverie_core::worker_wire::WorkerFrameHeader::for_payload(b'T', raw.len())
                    .unwrap()
                    .encode(),
            )
            .unwrap();
        client.write_all(raw).unwrap();
        let mut wire = Vec::new();
        client.read_to_end(&mut wire).unwrap();
        let corpus: Value = serde_json::from_str(include_str!(
            "../../../../reverie-host/src/worker_reports/tests/legacy.json"
        ))
        .unwrap();
        let expected = corpus["cases"][0]["responseHex"]
            .as_str()
            .unwrap()
            .as_bytes()
            .chunks_exact(2)
            .map(|value| u8::from_str_radix(std::str::from_utf8(value).unwrap(), 16).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            wire, expected,
            "same captured collector, exact original full response"
        );
        task.join().unwrap().unwrap();
    });
    assert!(!cancelled.is_cancelled());
    broker
        .close_command_telemetry(Instant::now() + Duration::from_secs(2))
        .unwrap();
    assert!(cancelled.is_cancelled());
    assert!(
        !tree.root.join("calls.txt").exists(),
        "default-off remains real config, no inventory"
    );
    broker
        .storage
        .runtime
        .close(Instant::now() + Duration::from_secs(2))
        .unwrap();
}
