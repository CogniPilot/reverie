//! Actual fixed Rust child, local owned sockets and real request seats.
use super::*;
use reverie_contracts::{worker_config, worker_schema::WorkerEnvelope};
fn fixture() -> Fixture {
    let mut fixture = Fixture::new("127.0.0.1:9".parse().unwrap());
    fixture
        .service
        .close(Instant::now() + Duration::from_secs(2))
        .unwrap();
    fixture
        .runtime
        .close(Instant::now() + Duration::from_secs(2))
        .unwrap();
    let mut raw: serde_json::Value = serde_json::from_str(include_str!(
        "../../../reverie-contracts/tests/fixtures/broker-laptop-python.json"
    ))
    .unwrap();
    let config = &mut raw["configuration"];
    config["companyRoot"] = serde_json::json!(fixture.root);
    let config = worker_config::decode(&serde_json::to_vec(config).unwrap()).unwrap();
    let envelope = WorkerEnvelope::capture(config.clone()).unwrap();
    let program = fixture.root.join("image-refresh");
    fs::hard_link(crate::engine_metadata::tests::program(), &program).unwrap();
    let bootstrap =
        EngineBootstrap::from_service(program.as_os_str(), BTreeMap::new(), fixture.root.clone())
            .unwrap();
    let runtime = WorkerRuntime::new(InstalledWorkerEngine::new(bootstrap), envelope.base());
    let telemetry =
        Arc::new(crate::command_telemetry::CommandTelemetry::capture(&runtime, &config).unwrap());
    let service = OfficeService::from_worker(&runtime, &config, telemetry).unwrap();
    fixture.runtime = runtime;
    fixture.service = service;
    fs::write(fixture.root.join("inspect.out"), br#"[{"State":{"Running":true},"NetworkSettings":{"Networks":{"bridge":{"IPAddress":"127.0.0.1"}}}}]"#).unwrap();
    fs::write(fixture.root.join("ps.out"), "").unwrap();
    fixture
}
fn lifetime(live: Arc<AtomicUsize>) -> Arc<request::RequestLifetime> {
    request::RequestLifetime::new(
        Arc::new(Semaphore::new(4)).try_acquire_owned().unwrap(),
        global_slots().try_acquire_owned().unwrap(),
        live,
    )
}
fn queries(fixture: &Fixture) -> Vec<String> {
    fs::read_to_string(fixture.root.join("calls.txt"))
        .unwrap_or_default()
        .lines()
        .map(str::to_owned)
        .collect()
}
#[test]
fn worker_phone_is_lazy_and_uses_only_its_actual_runtime_fixed_server() {
    let fixture = fixture();
    let phone = fixture.bind("phone");
    assert!(queries(&fixture).is_empty());
    let live = Arc::new(AtomicUsize::new(0));
    let runtime = server::runtime().unwrap();
    let addresses = runtime
        .block_on(
            fixture
                .service
                .company
                .address
                .targets(&fixture.service.company, lifetime(live.clone())),
        )
        .unwrap();
    assert_eq!(
        addresses,
        vec!["127.0.0.1:3000".parse::<SocketAddr>().unwrap()]
    );
    assert_eq!(queries(&fixture), vec!["inspect\0test-console"]);
    assert_eq!(live.load(Ordering::Acquire), 0);
    assert!(
        fixture
            .service
            .update_address("127.0.0.2".parse().unwrap())
            .is_err()
    );
    fixture
        .service
        .close_phone(&phone, Instant::now() + Duration::from_secs(2))
        .unwrap();
}
#[test]
fn actual_company_cache_retains_original_literal_only_after_valid_inspection() {
    let fixture = fixture();
    let runtime = server::runtime().unwrap();
    let live = Arc::new(AtomicUsize::new(0));
    let get = || {
        runtime.block_on(
            fixture
                .service
                .company
                .address
                .targets(&fixture.service.company, lifetime(live.clone())),
        )
    };
    assert!(get().is_ok());
    fs::write(fixture.root.join("inspect.out"), "[]").unwrap();
    assert!(get().is_ok());
    assert_eq!(queries(&fixture).len(), 1);
    // Use the actual source2-second cache lifetime, with no production clock
    // selector or private timestamp rewrite standing in for expiration.
    std::thread::sleep(Duration::from_millis(2100));
    assert!(get().is_err());
    assert!(get().is_err());
    assert_eq!(queries(&fixture).len(), 3);
    assert_eq!(live.load(Ordering::Acquire), 0);
}
#[test]
fn cancelled_http_keeps_actual_native_job_and_request_seats_until_settlement() {
    let fixture = fixture();
    let phone = fixture.bind("phone");
    fs::write(fixture.root.join("hold.next"), "owned next query").unwrap();
    let mut stream = UnixStream::connect(fixture.root.join("phone/office.sock")).unwrap();
    stream
        .write_all(b"GET /api/instances HTTP/1.1\r\nHost: guest\r\nContent-Length: 0\r\n\r\n")
        .unwrap();
    let end = Instant::now() + Duration::from_secs(5);
    while !fixture.root.join("query-started").exists() && Instant::now() < end {
        std::thread::sleep(Duration::from_millis(2));
    }
    let entered = fixture.root.join("query-started").exists();
    if !entered {
        fs::write(fixture.root.join("query-release"), "cleanup setup").unwrap();
    }
    let close = fixture
        .service
        .close_phone(&phone, Instant::now() + Duration::from_millis(50));
    drop(stream);
    let retained = phone.owned.live_requests.load(Ordering::Acquire);
    let service_close = fixture
        .service
        .close(Instant::now() + Duration::from_millis(50));
    fs::write(fixture.root.join("query-release"), "same actual child").unwrap();
    fixture
        .service
        .close(Instant::now() + Duration::from_secs(5))
        .unwrap();
    assert!(entered, "actual owned query setup");
    assert!(close.is_err());
    assert!(service_close.is_err());
    assert_eq!(retained, 1);
    assert_eq!(phone.owned.live_requests.load(Ordering::Acquire), 0);
    assert_eq!(queries(&fixture), vec!["inspect\0test-console"]);
}
