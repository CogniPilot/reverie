use super::*;
mod protected;
use crate::{reservation_gate::tests::Tree, worker_validation::load_owner_config};
use reverie_core::worker_wire::{HEADER_BYTES, WorkerFrameHeader};
use reverie_host::{
    engine_metadata::EngineBootstrap, installed_worker_engine::InstalledWorkerEngine,
    worker_runtime::WorkerRuntime,
};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    time::Duration,
};
fn fixture(tree: &Tree) -> InstallingBroker {
    let mut raw: serde_json::Value = serde_json::from_slice(&tree.raw).unwrap();
    raw.as_object_mut().unwrap().remove("resourceReservations");
    tree.write("worker.json", &serde_json::to_vec(&raw).unwrap());
    fs::remove_file(tree.root.join("state/resource-reservation-control.json")).unwrap();
    let snapshot = load_owner_config(&tree.root.join("worker.json")).unwrap();
    let bootstrap = EngineBootstrap::from_service(
        std::env::current_exe().unwrap().as_os_str(),
        BTreeMap::new(),
        tree.root.clone(),
    )
    .unwrap();
    let runtime = WorkerRuntime::new(
        InstalledWorkerEngine::new(bootstrap),
        snapshot.envelope().base(),
    );
    InstallingBroker::new(snapshot, runtime).unwrap()
}
fn end() -> Instant {
    Instant::now() + Duration::from_secs(2)
}
fn incoming(broker: &InstallingBroker, kind: u8) -> (UnixStream, UnixStream) {
    incoming_as(broker, kind, "00000000-0000-0000-0000-000000000000", false)
}
pub(super) fn incoming_as(
    broker: &InstallingBroker,
    kind: u8,
    sid: &str,
    attach: bool,
) -> (UnixStream, UnixStream) {
    let (mut client, server) = UnixStream::pair().unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let config = broker.configuration().unwrap();
    let raw: serde_json::Value = serde_json::from_slice(
        &reverie_contracts::worker_config::encode_config(config.configuration()),
    )
    .unwrap();
    let payload = if kind == b'T' {
        serde_json::json!({"v":1,"action":"command-failures","employee_ids":[]})
    } else {
        serde_json::json!({"sessionId":sid,"cwd":raw["mounts"][0]["destination"],"command":"echo hello","env":{},"cols":80,"rows":24,"attachOnly":attach})
    };
    let bytes = serde_json::to_vec(&payload).unwrap();
    client
        .write_all(
            &WorkerFrameHeader::for_payload(kind, bytes.len())
                .unwrap()
                .encode(),
        )
        .unwrap();
    client.write_all(&bytes).unwrap();
    (client, server)
}
#[test]
fn real_accept_dispatches_report_and_retains_j_on_same_runtime_without_engine_effects() {
    let tree = Tree::new();
    let broker = fixture(&tree);
    let (mut client, server) = incoming(&broker, b'T');
    assert!(matches!(
        broker.accept_worker_connection(server).unwrap(),
        WorkerConnectionDispatch::ReportCompleted
    ));
    let mut header = [0; HEADER_BYTES];
    client.read_exact(&mut header).unwrap();
    assert_eq!(WorkerFrameHeader::decode(header).kind(), b'J');
    let (_client, server) = incoming(&broker, b'J');
    let WorkerConnectionDispatch::Launch(request) =
        broker.accept_worker_connection(server).unwrap()
    else {
        panic!("J")
    };
    assert!(request.connection.same_runtime(&broker.storage.runtime));
    let entered = request.begin_ordinary().unwrap();
    assert!(
        entered.admission.is_none(),
        "actual absent captured Gate, not a supplied selector"
    );
    assert_eq!(
        entered.request().session().as_str(),
        "00000000-0000-0000-0000-000000000000"
    );
    entered.close(end()).unwrap();
    assert!(!tree.root.join("calls.txt").exists());
    broker.close_command_telemetry(end()).unwrap();
}
#[test]
fn actual_j_image_refresh_precedes_entry_and_retains_current_same_service_tuple() {
    let tree = Tree::new();
    let broker = fixture(&tree);
    let (_client, server) = incoming(&broker, b'J');
    let WorkerConnectionDispatch::Launch(request) =
        broker.accept_worker_connection(server).unwrap()
    else {
        panic!("J")
    };
    let mut raw: serde_json::Value =
        serde_json::from_slice(&fs::read(tree.root.join("worker.json")).unwrap()).unwrap();
    raw["image"] = serde_json::json!(format!("sha256:{}", "b".repeat(64)));
    tree.write("worker.json", &serde_json::to_vec(&raw).unwrap());
    let entered = request.begin_ordinary().unwrap();
    assert_eq!(
        entered.configuration().envelope().base().image(),
        format!("sha256:{}", "b".repeat(64))
    );
    entered.close(end()).unwrap();
    broker.close_command_telemetry(end()).unwrap();
}
#[test]
fn closed_j_connection_cannot_later_enter_and_late_durable_fence_remains_required() {
    let tree = Tree::new();
    let broker = fixture(&tree);
    let (_client, server) = incoming(&broker, b'J');
    let WorkerConnectionDispatch::Launch(request) =
        broker.accept_worker_connection(server).unwrap()
    else {
        panic!("J")
    };
    request.close(end()).unwrap();
    let failure = request.begin_ordinary().err().unwrap();
    assert!(matches!(failure.cause(), WorkerDispatchError::Transport(_)));
    failure.close(end()).unwrap();
    let (_client, server) = incoming(&broker, b'J');
    let WorkerConnectionDispatch::Launch(request) =
        broker.accept_worker_connection(server).unwrap()
    else {
        panic!("J")
    };
    tree.write(
        "state/resource-reservation-control.pending",
        b"actual late durable pending",
    );
    let failure = request.begin_ordinary().err().unwrap();
    assert!(failure.cause().to_string().contains("RECONCILIATION"));
    failure.close(end()).unwrap();
    broker.close_command_telemetry(end()).unwrap();
}
#[test]
fn bad_actual_image_reload_keeps_real_socket_owned_until_checked_failure_close() {
    let tree = Tree::new();
    let broker = fixture(&tree);
    let (mut client, server) = incoming(&broker, b'J');
    let WorkerConnectionDispatch::Launch(request) =
        broker.accept_worker_connection(server).unwrap()
    else {
        panic!("J")
    };
    tree.write("worker.json", b"not json");
    let failure = request.begin_ordinary().err().unwrap();
    assert!(matches!(failure.cause(), WorkerDispatchError::Gate(_)));
    failure.close(end()).unwrap();
    assert_eq!(client.read(&mut [0]).unwrap(), 0);
    broker.close_command_telemetry(end()).unwrap();
}

#[test]
fn actual_j_configured_gate_retains_the_real_flock_until_checked_prefix_close() {
    crate::test_process::owning_case!(
        actual_j_configured_gate_retains_the_real_flock_until_checked_prefix_close
    );
    let tree = Tree::new();
    tree.write("ids.out", b"");
    let snapshot = load_owner_config(&tree.root.join("worker.json")).unwrap();
    let bootstrap = EngineBootstrap::from_service(
        super::super::recovered::tests::program().as_os_str(),
        BTreeMap::new(),
        tree.root.clone(),
    )
    .unwrap();
    let runtime = WorkerRuntime::new(
        InstalledWorkerEngine::new(bootstrap),
        snapshot.envelope().base(),
    );
    let broker = InstallingBroker::new(snapshot, runtime).unwrap();
    let (_client, server) =
        incoming_as(&broker, b'J', "11111111-2222-4333-8444-555555555555", true);
    let WorkerConnectionDispatch::Launch(request) =
        broker.accept_worker_connection(server).unwrap()
    else {
        panic!("J")
    };
    let entered = request.begin_ordinary().unwrap();
    assert!(entered.admission.is_some());
    let config = reverie_contracts::reservation_engine::ReservationConfiguration::capture(
        broker.configuration().unwrap().configuration().clone(),
    );
    assert!(
        matches!(reverie_host::reservation_control::AdmissionLock::acquire(&config), Err(error) if error.code()=="RESERVATION_ADMISSION_LOCK_BUSY")
    );
    entered.close(end()).unwrap();
    reverie_host::reservation_control::AdmissionLock::acquire(&config)
        .unwrap()
        .close()
        .unwrap();
    let calls = fs::read_to_string(tree.root.join("calls.txt")).unwrap();
    assert!(
        calls.lines().all(|line| line.starts_with("ps\0")),
        "only real readonly admission inventory: {calls}"
    );
    assert!(!tree.root.join("state/storage-locks").exists());
    broker.close_command_telemetry(end()).unwrap();
}

#[test]
fn unavailable_actual_current_owner_still_checked_closes_the_incoming_socket() {
    let tree = Tree::new();
    let broker = fixture(&tree);
    // This refusal precedes any frame read. An empty actual accepted socket
    // gives a deterministic EOF; queued unread bytes instead make Linux report
    // ECONNRESET on checked close, as preserved in the original failed fixture.
    let (mut client, server) = UnixStream::pair().unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    assert!(
        std::panic::catch_unwind(|| {
            let _held = broker.installed.current.write().unwrap();
            panic!("owned current publication poison");
        })
        .is_err()
    );
    assert!(matches!(
        broker.accept_worker_connection(server),
        Err(WorkerDispatchError::Configuration { cleanup: None, .. })
    ));
    assert_eq!(client.read(&mut [0]).unwrap(), 0);
    broker.close_command_telemetry(end()).unwrap();
}
