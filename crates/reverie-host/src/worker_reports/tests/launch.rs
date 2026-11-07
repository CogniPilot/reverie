use super::*;
fn configuration() -> worker_config::EffectiveWorkerConfig {
    worker_config::decode(
        br#"{"mounts":[{"source":"/owned","destination":"/work","readOnly":false}]}"#,
    )
    .unwrap()
}
const LAUNCH: &[u8] = br#"{"sessionId":"00000000-0000-0000-0000-000000000000","cwd":"/work","command":"echo hello","env":{},"cols":80,"rows":24}"#;
fn launch(
    service: &Arc<WorkerReportService>,
    fixture: &Fixture,
) -> (UnixStream, WorkerLaunchConnection) {
    let (mut client, server) = fixture.sockets();
    send(&mut client, b'J', LAUNCH);
    let AcceptedWorkerConnection::Launch(connection) = service
        .accept(server, &fixture.collector, &configuration())
        .unwrap()
    else {
        panic!("actual J")
    };
    (client, connection)
}
#[test]
fn actual_j_socket_retains_same_origin_and_checked_close_is_terminal() {
    let fixture = Fixture::new();
    let other = Fixture::new();
    let service = Arc::new(fixture.service());
    let (mut client, connection) = launch(&service, &fixture);
    assert_eq!(
        connection.request().session().as_str(),
        "00000000-0000-0000-0000-000000000000"
    );
    assert!(connection.same_runtime(&fixture.runtime));
    assert!(!connection.same_runtime(&other.runtime));
    assert!(connection.assert_open(&other.runtime).is_err());
    connection.assert_open(&fixture.runtime).unwrap();
    assert_eq!(service.records.lock().unwrap().len(), 1);
    connection.close(end()).unwrap();
    assert_eq!(client.read(&mut [0]).unwrap(), 0);
    assert!(connection.assert_open(&fixture.runtime).is_err());
    connection.close(end()).unwrap();
    service.close(end()).unwrap();
}
#[test]
fn actual_t_and_j_share_one_cap_until_exact_j_owner_closes() {
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    let mut retained = (0..service.limit)
        .map(|_| launch(&service, &fixture))
        .collect::<Vec<_>>();
    let (_client, server) = fixture.sockets();
    assert!(matches!(
        service.accept(server, &fixture.collector, &configuration()),
        Err(WorkerReportError::Stopping)
    ));
    let (_, closed) = retained.pop().unwrap();
    closed.close(end()).unwrap();
    let (mut client, server) = fixture.sockets();
    send(&mut client, b'T', REQUEST);
    assert!(matches!(
        service
            .accept(server, &fixture.collector, &configuration())
            .unwrap(),
        AcceptedWorkerConnection::ReportCompleted
    ));
    assert_eq!(reply(&mut client).0, b'J');
    assert_eq!(service.records.lock().unwrap().len(), service.limit - 1);
    for (_, connection) in retained {
        connection.close(end()).unwrap();
    }
    service.close(end()).unwrap();
}
#[test]
fn j_actual_peer_refusal_precedes_collector_origin_and_payload() {
    let fixture = Fixture::new();
    let other = Fixture::new();
    let mut value = fixture.service();
    value.uid ^= 1;
    let service = Arc::new(value);
    let (mut client, server) = fixture.sockets();
    let error = service
        .accept(server, &other.collector, &configuration())
        .err()
        .unwrap();
    assert!(matches!(error, WorkerReportError::Peer));
    assert_eq!(
        reply(&mut client),
        (b'E', b"Worker peer identity is not authorized".to_vec())
    );
    service.close(end()).unwrap();
}
#[test]
fn j_wrong_purpose_and_actual_schema_refusals_preserve_error_bytes_and_close() {
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    for (kind, payload, expected) in [
        (b'C', LAUNCH, "Expected worker launch request"),
        (b'J', b"{}".as_slice(), "Invalid worker request"),
        (b'J', b"null".as_slice(), "Invalid worker request"),
    ] {
        let (mut client, server) = fixture.sockets();
        send(&mut client, kind, payload);
        assert!(
            service
                .accept(server, &fixture.collector, &configuration())
                .is_err()
        );
        assert_eq!(reply(&mut client), (b'E', expected.as_bytes().to_vec()));
        assert_eq!(client.read(&mut [0]).unwrap(), 0);
        assert!(service.records.lock().unwrap().is_empty());
    }
    service.close(end()).unwrap();
}
#[test]
fn j_checked_close_refusal_retains_same_record_origin_and_fences_completion() {
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    let (mut client, connection) = launch(&service, &fixture);
    CLOSE_REFUSAL.with(|flag| flag.set(true));
    assert!(connection.close(end()).is_err());
    assert_eq!(client.read(&mut [0]).unwrap(), 0);
    assert!(connection.assert_open(&fixture.runtime).is_err());
    assert!(connection.close(end()).is_err());
    assert_eq!(service.records.lock().unwrap().len(), 1);
    assert!(service.close(end()).is_err());
}
#[test]
fn j_fragmented_header_and_non_scalar_command_are_lossless_before_close() {
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    let (mut client, server) = fixture.sockets();
    let raw = String::from_utf8(LAUNCH.to_vec())
        .unwrap()
        .replace("echo hello", "\\ud800");
    std::thread::scope(|scope| {
        let task = scope.spawn(|| service.accept(server, &fixture.collector, &configuration()));
        for byte in WorkerFrameHeader::for_payload(b'J', raw.len())
            .unwrap()
            .encode()
        {
            client.write_all(&[byte]).unwrap();
        }
        client.write_all(raw.as_bytes()).unwrap();
        let AcceptedWorkerConnection::Launch(connection) = task.join().unwrap().unwrap() else {
            panic!("J")
        };
        assert_eq!(connection.request().command().codepoints(), &[0xd800]);
        connection.close(end()).unwrap();
    });
    service.close(end()).unwrap();
}

#[test]
fn actual_python_request_schema_transcripts_match_owned_j_socket_outcomes() {
    let corpus: serde_json::Value =
        serde_json::from_str(include_str!("launch-python.json")).unwrap();
    assert_eq!(corpus["cases"].as_array().unwrap().len(), 19);
    let decode = |value: &serde_json::Value| {
        value
            .as_str()
            .unwrap()
            .as_bytes()
            .chunks_exact(2)
            .map(|p| u8::from_str_radix(std::str::from_utf8(p).unwrap(), 16).unwrap())
            .collect::<Vec<_>>()
    };
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    for case in corpus["cases"].as_array().unwrap() {
        let (mut client, server) = fixture.sockets();
        send(&mut client, b'J', &decode(&case["payloadHex"]));
        let result = service.accept(server, &fixture.collector, &configuration());
        if case["accepted"].as_bool().unwrap() {
            let AcceptedWorkerConnection::Launch(connection) = result.unwrap() else {
                panic!("actual J")
            };
            connection.close(end()).unwrap();
        } else {
            assert!(result.is_err(), "{}", case["name"]);
        }
        let mut observed = Vec::new();
        client.read_to_end(&mut observed).unwrap();
        assert_eq!(observed, decode(&case["responseHex"]), "{}", case["name"]);
    }
    service.close(end()).unwrap();
}

#[test]
fn closing_the_service_interrupts_j_but_cannot_ack_while_actual_connection_is_held() {
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    let (mut client, connection) = launch(&service, &fixture);
    assert!(service.close(Instant::now()).is_err());
    assert_eq!(client.read(&mut [0]).unwrap(), 0);
    assert_eq!(service.records.lock().unwrap().len(), 1);
    assert!(connection.assert_open(&fixture.runtime).is_err());
    connection.close(end()).unwrap();
    service.close(end()).unwrap();
}
