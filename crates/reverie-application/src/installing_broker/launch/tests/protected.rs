//! Actual L cannot enter the ordinary image/GPU/admission producer, even when
//! a trusted in-process caller has the genuine common transport capability.
use super::*;
#[test]
fn real_l_is_refused_before_current_configuration_or_any_ordinary_native_effect() {
    let tree = Tree::new();
    let broker = fixture(&tree);
    let snapshot = broker.configuration().unwrap();
    let config: serde_json::Value = serde_json::from_slice(
        &reverie_contracts::worker_config::encode_config(snapshot.configuration()),
    )
    .unwrap();
    let raw = serde_json::to_vec(&serde_json::json!({"reference":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        "request":{"sessionId":"00000000-0000-0000-0000-000000000000","cwd":config["mounts"][0]["destination"],
        "command":"echo hello","env":{},"cols":80,"rows":24}})).unwrap();
    let (mut client, server) = UnixStream::pair().unwrap();
    client
        .write_all(
            &WorkerFrameHeader::for_payload(b'L', raw.len())
                .unwrap()
                .encode(),
        )
        .unwrap();
    client.write_all(&raw).unwrap();
    let accepted = broker
        .reports
        .register_worker_connection(server)
        .unwrap()
        .receive_service_for_worker(broker.command_telemetry(), snapshot.configuration())
        .unwrap();
    let reverie_host::worker_reports::AcceptedWorkerServiceConnection::Service(source) = accepted
    else {
        panic!("genuine L")
    };
    let held = source
        .decode_protected_launch(snapshot.configuration())
        .ok()
        .unwrap()
        .retain_for_qualification()
        .ok()
        .unwrap();
    let (connection, _, _, mut hold) = held.into_parts();
    let poison = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _current = broker.installed.current.write().unwrap();
        panic!("owned current poison must remain unreachable from ordinary L refusal");
    }));
    assert!(poison.is_err());
    let failure = ReceivedWorkerLaunch {
        broker: &broker,
        connection,
    }
    .begin_ordinary()
    .err()
    .unwrap();
    assert!(matches!(
        failure.as_ref().cause(),
        WorkerDispatchError::Transport(WorkerReportError::LaunchKind)
    ));
    assert!(!tree.root.join("calls.txt").exists());
    failure.request.close_for_worker().unwrap();
    hold.release_for_worker().unwrap();
    broker.close_command_telemetry(end()).unwrap();
    broker.storage.runtime.close(end()).unwrap();
}
