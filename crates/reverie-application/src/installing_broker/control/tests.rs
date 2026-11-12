//! Actual accepted C Record and fixed native empty census; no live engine.
use super::*;
mod status;
use reverie_core::worker_wire::WorkerFrameHeader;
use std::{
    io::{Read, Write},
    os::unix::net::UnixStream,
};
fn incoming(broker: &InstallingBroker, raw: &[u8]) -> (UnixStream, WorkerServiceConnection) {
    let (mut client, server) = UnixStream::pair().unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    client
        .write_all(
            &WorkerFrameHeader::for_payload(b'C', raw.len())
                .unwrap()
                .encode(),
        )
        .unwrap();
    client.write_all(raw).unwrap();
    let snapshot = broker.configuration().unwrap();
    let accepted = broker
        .reports
        .register_worker_connection(server)
        .unwrap()
        .receive_service_for_worker(broker.command_telemetry(), snapshot.configuration())
        .unwrap();
    let reverie_host::worker_reports::AcceptedWorkerServiceConnection::Service(connection) =
        accepted
    else {
        panic!("genuine C")
    };
    (client, connection)
}
fn finish(
    root: std::path::PathBuf,
    broker: Arc<InstallingBroker>,
    client: UnixStream,
) -> Result<(), String> {
    let end = Instant::now() + Duration::from_secs(3);
    let results = [
        nix::unistd::close(client).map_err(|e| e.to_string()),
        broker.reports.close(end).map_err(|e| e.to_string()),
        broker.close_chat_images(end).map_err(|e| e.to_string()),
        broker
            .close_command_telemetry(end)
            .map_err(|e| e.to_string()),
        broker.storage.runtime.close(end).map_err(|e| e.to_string()),
    ];
    drop(broker);
    let errors = results
        .into_iter()
        .filter_map(Result::err)
        .collect::<Vec<_>>();
    if errors.is_empty() {
        std::fs::remove_dir_all(root).map_err(|e| e.to_string())
    } else {
        Err(errors.join("; "))
    }
}
#[test]
fn known_control_refusal_cannot_release_an_external_original_lifecycle_hold() {
    crate::test_process::owning_case!(
        known_control_refusal_cannot_release_an_external_original_lifecycle_hold
    );
    let (root, broker) = recovered::tests::Tree::bootstrap_parts("", "admission", 512, 4096);
    let broker = Arc::new(broker);
    let (client, connection) = incoming(&broker, br#"{"action":"unsupported-known"}"#);
    let mut hold = connection.retain_lifecycle().unwrap();
    let mut failure = broker.handle_control(connection).unwrap_err();
    let retained = !failure.reconcile();
    let pending = failure.owner.is_some();
    hold.release_for_worker().unwrap();
    let finalized = failure.reconcile();
    let cause = failure.to_string();
    drop(failure);
    let cleanup = finish(root, broker, client);
    cleanup.unwrap();
    assert!(
        retained && pending,
        "body refusal must retain the actual held record"
    );
    assert!(
        finalized,
        "only same-owner release permits later component close"
    );
    assert!(cause.contains("WORKER_CONTROL_UNSUPPORTED"));
}

#[test]
fn readonly_native_failure_keeps_the_same_frame_until_its_original_hold_is_released() {
    crate::test_process::owning_case!(
        readonly_native_failure_keeps_the_same_frame_until_its_original_hold_is_released
    );
    let (root, broker) = recovered::tests::Tree::bootstrap_parts("", "admission", 512, 4096);
    std::fs::write(root.join("names.out"), b"foreign-container\n").unwrap();
    let broker = Arc::new(broker);
    let (client, connection) = incoming(&broker, br#"{"action":"status"}"#);
    let mut failure = broker.handle_control(connection).unwrap_err();
    // Transfer the actual already-minted Hold, rather than manufacture a
    // second hold or a native-close uncertainty marker.
    let mut hold = failure.owner.as_mut().unwrap().hold.take().unwrap();
    let retained = !failure.reconcile_known_refusal() && failure.owner.is_some();
    hold.release_for_worker().unwrap();
    let finalized = failure.reconcile_known_refusal();
    let cause = failure.to_string();
    drop(failure);
    let cleanup = finish(root, broker, client);
    cleanup.unwrap();
    assert!(
        retained,
        "readonly Native failure cannot erase its original held record"
    );
    assert!(
        finalized,
        "only actual same-Hold release permits finalization"
    );
    assert!(cause.contains("WORKER_CONTROL_STOP_CENSUS"));
}
#[test]
fn actual_empty_fleet_census_and_checked_close_precede_success_reply() {
    crate::test_process::owning_case!(
        actual_empty_fleet_census_and_checked_close_precede_success_reply
    );
    let (root, broker) = recovered::tests::Tree::bootstrap_parts("", "admission", 512, 4096);
    let broker = Arc::new(broker);
    let (mut client, connection) = incoming(&broker, br#"{"action":"stop-laptops"}"#);
    let result = broker.handle_control(connection).map_err(|mut failure| {
        let _ = failure.reconcile();
        failure.to_string()
    });
    let mut header = [0; 5];
    let read = client.read_exact(&mut header);
    let frame = WorkerFrameHeader::decode(header);
    let mut bytes = vec![0; frame.payload_length() as usize];
    let body = client.read_exact(&mut bytes);
    let calls = std::fs::read_to_string(root.join("calls.txt")).unwrap_or_default();
    let cleanup = finish(root, broker, client);
    result.unwrap();
    cleanup.unwrap();
    read.unwrap();
    body.unwrap();
    assert_eq!(frame.kind(), b'J');
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&bytes).unwrap(),
        serde_json::json!({"action":"stop-laptops","success":true})
    );
    assert_eq!(
        calls
            .lines()
            .filter(|line| line.starts_with("ps\0--filter\0"))
            .count(),
        2
    );
}
#[test]
fn unsupported_agent_stop_never_dispatches_native_work_and_known_refusal_closes() {
    crate::test_process::owning_case!(
        unsupported_agent_stop_never_dispatches_native_work_and_known_refusal_closes
    );
    let (root, broker) = recovered::tests::Tree::bootstrap_parts("", "admission", 512, 4096);
    let broker = Arc::new(broker);
    let (mut client, connection) = incoming(
        &broker,
        br#"{"action":"stop-agent","sessionId":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"}"#,
    );
    let result = broker.handle_control(connection).map_err(|mut failure| {
        let _ = failure.reconcile();
        failure.to_string()
    });
    let mut header = [0; 5];
    let read = client.read_exact(&mut header);
    let header = WorkerFrameHeader::decode(header);
    let mut bytes = vec![0; header.payload_length() as usize];
    let body = client.read_exact(&mut bytes);
    let dispatched = root.join("calls.txt").exists();
    let cleanup = finish(root, broker, client);
    cleanup.unwrap();
    result.unwrap();
    read.unwrap();
    body.unwrap();
    assert_eq!(header.kind(), b'J');
    let response: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(response["dispatched"], false);
    assert_eq!(response["success"], false);
    assert!(!dispatched);
}

#[test]
fn shared_native_drain_never_replays_a_completed_native_stop_sequence() {
    crate::test_process::owning_case!(
        shared_native_drain_never_replays_a_completed_native_stop_sequence
    );
    let (root, broker) = recovered::tests::Tree::bootstrap_parts("", "admission", 512, 4096);
    let broker = Arc::new(broker);
    let mut drain = LegacyFleetDrain::new(&broker, Instant::now() + Duration::from_secs(5));
    let first = drain.run_ordinary();
    let before = std::fs::read(root.join("calls.txt")).unwrap_or_default();
    let second = drain.run_ordinary();
    let after = std::fs::read(root.join("calls.txt")).unwrap_or_default();
    drop(drain);
    let (client, server) = UnixStream::pair().unwrap();
    let closed = nix::unistd::close(server);
    let cleanup = finish(root, broker, client);
    first.unwrap();
    closed.unwrap();
    cleanup.unwrap();
    assert!(
        second.is_err(),
        "the same completed drain must not obtain a fresh lifecycle generation"
    );
    assert_eq!(
        before, after,
        "the original native census/stop sequence must not replay"
    );
}

#[test]
fn shared_native_drain_failed_attempt_is_not_replayed_during_original_component_cleanup() {
    crate::test_process::owning_case!(
        shared_native_drain_failed_attempt_is_not_replayed_during_original_component_cleanup
    );
    let (root, broker) =
        recovered::tests::Tree::bootstrap_parts("foreign-name\n", "admission", 512, 4096);
    let broker = Arc::new(broker);
    let mut drain = LegacyFleetDrain::new(&broker, Instant::now() + Duration::from_secs(5));
    let first = drain.run_ordinary();
    let before = std::fs::read(root.join("calls.txt")).unwrap_or_default();
    let second = drain.run_ordinary();
    let settled = drain.settle_components();
    let closed = drain.abort_admission();
    let after = std::fs::read(root.join("calls.txt")).unwrap_or_default();
    drop(drain);
    let (client, server) = UnixStream::pair().unwrap();
    let socket = nix::unistd::close(server);
    let cleanup = finish(root, broker, client);
    socket.unwrap();
    cleanup.unwrap();
    closed.unwrap();
    assert!(first.is_err() && second.is_err());
    assert!(settled.is_empty());
    assert_eq!(
        before, after,
        "settlement only closes original tickets; no new census is dispatched"
    );
}

#[test]
fn shared_native_drain_expired_original_deadline_refuses_before_any_native_census() {
    crate::test_process::owning_case!(
        shared_native_drain_expired_original_deadline_refuses_before_any_native_census
    );
    let (root, broker) = recovered::tests::Tree::bootstrap_parts("", "admission", 512, 4096);
    let broker = Arc::new(broker);
    let before = std::fs::read(root.join("calls.txt")).unwrap_or_default();
    let mut drain = LegacyFleetDrain::new(&broker, Instant::now());
    let result = drain.run_ordinary();
    let closed = drain.abort_admission();
    let after = std::fs::read(root.join("calls.txt")).unwrap_or_default();
    drop(drain);
    let (client, server) = UnixStream::pair().unwrap();
    let socket = nix::unistd::close(server);
    let cleanup = finish(root, broker, client);
    socket.unwrap();
    cleanup.unwrap();
    closed.unwrap();
    assert!(matches!(
        result,
        Err(DrainCause::Refused("WORKER_FLEET_DRAIN_DEADLINE"))
    ));
    assert_eq!(before, after);
}
