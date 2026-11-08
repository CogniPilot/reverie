//! Actual accepted C Record and fixed native empty census; no live engine.
use super::*;
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
    let (client, connection) = incoming(
        &broker,
        br#"{"action":"stop-agent","sessionId":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"}"#,
    );
    let mut failure = broker
        .handle_control(connection)
        .expect_err("closed refusal");
    let settled = failure.reconcile();
    let cause = failure.to_string();
    let dispatched = root.join("calls.txt").exists();
    drop(failure);
    let cleanup = finish(root, broker, client);
    cleanup.unwrap();
    assert!(settled);
    assert!(!dispatched);
    assert!(cause.contains("WORKER_CONTROL_UNSUPPORTED"));
}
