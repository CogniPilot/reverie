use super::*;
use crate::command_telemetry::CommandTelemetry;
use reverie_contracts::{worker_config, worker_schema::WorkerEnvelope};
use serde_json::json;
const E: &str = "22222222-2222-4222-8222-222222222222";
fn fixture() -> (Fixture, Arc<CommandTelemetry>) {
    let mut fixture = Fixture::new("127.0.0.1:9".parse().unwrap());
    fixture
        .service
        .close(Instant::now() + Duration::from_secs(2))
        .unwrap();
    fixture
        .runtime
        .close(Instant::now() + Duration::from_secs(2))
        .unwrap();
    for directory in ["company", "state", "shared"] {
        fs::create_dir(fixture.root.join(directory)).unwrap();
        fs::set_permissions(
            fixture.root.join(directory),
            fs::Permissions::from_mode(0o700),
        )
        .unwrap();
    }
    let company = fixture.root.join("company/employees.json");
    fs::write(&company, serde_json::to_vec(&json!({"employees":[{"id":E,"owner":"fixture","sessionId":SID,"desiredRunning":true}]})).unwrap()).unwrap();
    fs::set_permissions(&company, fs::Permissions::from_mode(0o600)).unwrap();
    let mut source: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../reverie-contracts/tests/fixtures/broker-laptop-python.json"
    ))
    .unwrap();
    let raw = &mut source["configuration"];
    raw["uid"] = json!(crate::native::uid());
    raw["gid"] = json!(crate::native::uid());
    raw["companyRoot"] = json!(fixture.root.join("company"));
    raw["companyFile"] = json!(company);
    raw["stateRoot"] = json!(fixture.root.join("state"));
    raw["scratchRoot"] = json!(fixture.root.join("scratch"));
    raw["apiSocketRoot"] = json!(fixture.root.join("api"));
    raw["socket"] = json!(fixture.root.join("worker.sock"));
    for mount in raw["mounts"].as_array_mut().unwrap() {
        mount["source"] = json!(fixture.root.join("shared"));
    }
    raw["commandTelemetry"] = json!({"enabled":true,"keys":["shell"]});
    let config = worker_config::decode(&serde_json::to_vec(raw).unwrap()).unwrap();
    let envelope = WorkerEnvelope::capture(config.clone()).unwrap();
    let program = fixture.root.join("command-telemetry");
    fs::hard_link(crate::engine_metadata::tests::program(), &program).unwrap();
    fs::write(fixture.root.join("ps.out"), b"").unwrap();
    let bootstrap =
        EngineBootstrap::from_service(program.as_os_str(), BTreeMap::new(), fixture.root.clone())
            .unwrap();
    let runtime = WorkerRuntime::new(InstalledWorkerEngine::new(bootstrap), envelope.base());
    let collector = Arc::new(CommandTelemetry::capture(&runtime, &config).unwrap());
    fixture.service = OfficeService::from_worker(&runtime, &config, collector.clone()).unwrap();
    fixture.runtime = runtime;
    (fixture, collector)
}
fn event() -> &'static [u8] {
    br#"{"v":1,"tool":"shell","exit_code":127,"execution_id":"00000000-0000-0000-0000-000000000000"}"#
}
fn database(fixture: &Fixture) -> PathBuf {
    fixture.root.join(format!(
        "state/command-telemetry/{E}/hands/command-failures.sqlite"
    ))
}
fn empty(response: &[u8], status: &str) {
    assert!(
        response.starts_with(format!("HTTP/1.1 {status}").as_bytes()),
        "{}",
        String::from_utf8_lossy(response)
    );
    let split = response
        .windows(4)
        .position(|bytes| bytes == b"\r\n\r\n")
        .unwrap();
    assert_eq!(&response[split + 4..], b"");
}
#[test]
fn actual_phone_session_collects_locally_before_missing_credentials_or_lazy_backend() {
    let (fixture, collector) = fixture();
    let _phone = fixture.bind("phone");
    assert!(!fixture.root.join("company/console/.env").exists());
    let response = fixture.request(
        "phone",
        "POST",
        "/api/command-telemetry/hands",
        event(),
        "Authorization: Basic guest\r\nParent-Session: forged\r\nCookie: guest\r\n",
    );
    empty(&response, "204");
    let report = collector
        .report(&ProfileSessionId::parse(SID).unwrap())
        .unwrap();
    assert_eq!(report.employee().as_str(), E);
    assert_eq!(report.counts()[0].count(), 1);
    assert_eq!(
        fs::read_to_string(fixture.root.join("calls.txt"))
            .unwrap()
            .lines()
            .count(),
        1,
        "only constructor's real ps; no backend inspect"
    );
}
#[test]
fn closed_route_and_unbound_session_refuse_without_initializing_a_learning_log() {
    let (fixture, _) = fixture();
    let _phone = fixture.bind("phone");
    for (method, target, body, status) in [
        ("GET", "/api/command-telemetry/hands", event(), "400"),
        ("POST", "/api/command-telemetry/hands?x=1", event(), "400"),
        ("POST", "/api/command-telemetry/hands", b"{}".as_slice(), "503"),
        ("POST", "/api/command-telemetry/hands", br#"{"v":1,"tool":"shell","exit_code":127,"execution_id":"00000000-0000-0000-0000-000000000000","sessionId":"forged"}"#.as_slice(), "503"),
    ] {
        let response = fixture.request("phone", method, target, body, "");
        assert!(response.starts_with(format!("HTTP/1.1 {status}").as_bytes()));
        assert!(!database(&fixture).exists());
    }
    let _other = fixture
        .service
        .bind(
            fixture.root.join("other"),
            ProfileSessionId::parse("00000000-0000-0000-0000-000000000000").unwrap(),
        )
        .unwrap();
    empty(
        &fixture.request("other", "POST", "/api/command-telemetry/hands", event(), ""),
        "503",
    );
    assert!(!database(&fixture).exists());
}
#[test]
fn absent_legacy_collector_returns_empty_503_without_forwarding_or_credentials() {
    let fixture = Fixture::new("127.0.0.1:9".parse().unwrap());
    let _phone = fixture.bind("phone");
    empty(
        &fixture.request("phone", "POST", "/api/command-telemetry/hands", event(), ""),
        "503",
    );
}
#[test]
fn aborted_http_request_retains_real_native_thread_seats_and_collector_until_join() {
    let (fixture, collector) = fixture();
    let phone = fixture.bind("phone");
    let producer = collector.hold_producer_for_owned_test();
    let mut stream = UnixStream::connect(fixture.root.join("phone/office.sock")).unwrap();
    write!(
        stream,
        "POST /api/command-telemetry/hands HTTP/1.1\r\nHost: guest\r\nContent-Length: {}\r\n\r\n",
        event().len()
    )
    .unwrap();
    stream.write_all(event()).unwrap();
    let until = Instant::now() + Duration::from_secs(2);
    while fixture.service.company.native_jobs.known_settled() {
        assert!(Instant::now() < until, "actual telemetry job registered");
        std::thread::sleep(Duration::from_millis(1));
    }
    stream.shutdown(std::net::Shutdown::Both).unwrap();
    drop(stream);
    assert!(
        fixture
            .service
            .close_phone(&phone, Instant::now() + Duration::from_millis(20))
            .is_err()
    );
    assert_eq!(phone.owned.live_requests.load(Ordering::Acquire), 1);
    assert!(
        fixture
            .service
            .close(Instant::now() + Duration::from_millis(20))
            .is_err()
    );
    assert!(
        !database(&fixture).exists(),
        "actual producer lock still held"
    );
    drop(producer);
    fixture
        .service
        .close(Instant::now() + Duration::from_secs(2))
        .unwrap();
    assert_eq!(phone.owned.live_requests.load(Ordering::Acquire), 0);
    assert_eq!(
        collector
            .report(&ProfileSessionId::parse(SID).unwrap())
            .unwrap()
            .counts()[0]
            .count(),
        1,
        "disconnect did not undo or replay the single result"
    );
}
