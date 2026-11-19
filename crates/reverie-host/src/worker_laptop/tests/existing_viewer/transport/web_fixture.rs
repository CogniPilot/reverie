//! The web acceptance driver owns tmux and its provider. This fixture runs
//! the native attach-only J path with a fixed, synthetic engine adapter.
use super::*;
use crate::{command_telemetry::CommandTelemetry, worker_reports::AcceptedWorkerConnection};
use std::{io, os::unix::net::UnixListener, sync::atomic::AtomicBool, thread};

fn required_path(name: &str) -> PathBuf {
    PathBuf::from(std::env::var_os(name).unwrap())
}

#[test]
#[ignore = "started by the owned web viewer acceptance test"]
fn serve_web_viewer_fixture() {
    let root = required_path("FIXTURE_ROOT");
    let engine = std::env::var_os("FIXTURE_VIEWER_ENGINE").map(PathBuf::from);
    let fixture = Fixture::with_engine(
        "web-viewer",
        Default::default(),
        engine.as_deref().unwrap_or_else(|| program()),
        &root.join("work"),
    );
    fs::write(
        fixture.root.join("company.json"),
        serde_json::to_vec(&json!({"employees":[{"id":"11111111-2222-4333-8444-555555555555","sessionId":SID,"owner":null,"name":"Owned fixture","desiredRunning":true}]})).unwrap(),
    ).unwrap();
    fs::write(
        fixture.root.join("web-tmux"),
        required_path("FIXTURE_TMUX").as_os_str().as_encoded_bytes(),
    )
    .unwrap();
    fs::write(
        fixture.root.join("web-socket"),
        root.join("inner.sock").as_os_str().as_encoded_bytes(),
    )
    .unwrap();
    let socket = root.join("control/broker.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    fs::set_permissions(&socket, fs::Permissions::from_mode(0o600)).unwrap();
    listener.set_nonblocking(true).unwrap();
    let reports = Arc::new(WorkerReportService::from_runtime(fixture.runtime()));
    let telemetry = CommandTelemetry::capture(fixture.runtime(), &fixture.source).unwrap();
    fs::write(root.join("broker-ready"), b"ready\n").unwrap();
    serve(&listener, &fixture, &reports, &telemetry);
    reports.close(end()).unwrap();
    drop(listener);
    fs::remove_file(socket).unwrap();
}

fn serve(
    listener: &UnixListener,
    fixture: &Fixture,
    reports: &Arc<WorkerReportService>,
    telemetry: &CommandTelemetry,
) {
    let stop = Arc::new(AtomicBool::new(false));
    let done = stop.clone();
    let input = thread::spawn(move || {
        let _ = io::stdin().read(&mut [0]);
        done.store(true, Ordering::Release);
    });
    while !stop.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((stream, _)) => attach(stream, fixture, reports, telemetry),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(2));
            }
            Err(error) => panic!("owned viewer fixture socket: {error}"),
        }
    }
    input.join().unwrap();
}

fn attach(
    stream: UnixStream,
    fixture: &Fixture,
    reports: &Arc<WorkerReportService>,
    telemetry: &CommandTelemetry,
) {
    let AcceptedWorkerConnection::Launch(connection) =
        reports.accept(stream, telemetry, &fixture.source).unwrap()
    else {
        panic!("only attach requests are supported");
    };
    assert_eq!(connection.request().attach_only(), Some(true));
    assert_eq!(connection.request().session().as_str(), SID);
    let hold = connection.retain_lifecycle().unwrap();
    let (mut storage, plan, inspection) = observe_existing(fixture, &"c".repeat(64));
    let receipt = super::super::relay::receipt(fixture, &mut storage);
    let existing = fixture
        .runtime()
        .retain_existing_relay_for_connection(storage, plan, inspection, receipt, &connection)
        .unwrap_or_else(|error| panic!("{}", error.cause()));
    let viewer = started(fixture, &existing, &connection);
    let relay = connection
        .begin_viewer_relay(fixture.runtime(), &viewer)
        .unwrap();
    run(relay, fixture);
    close_relay(fixture, &existing, connection, hold)
        .close(end())
        .unwrap();
}

#[test]
#[ignore = "signals the exact viewer selected by the owned web fixture"]
fn stop_web_viewer_fixture_client() {
    let pid: u32 = std::env::var("FIXTURE_VIEWER_PID")
        .unwrap()
        .parse()
        .unwrap();
    let selected = std::env::var("FIXTURE_VIEWER_START").unwrap();
    let process = PathBuf::from(format!("/proc/{pid}"));
    let handle = crate::native::perf_init_pidfd(pid).unwrap();
    let stat = fs::read_to_string(process.join("stat")).unwrap();
    assert_eq!(
        reverie_contracts::kernel_accounting::process_start(&stat).unwrap(),
        selected
    );
    assert_eq!(
        fs::read_link(process.join("exe")).unwrap(),
        required_path("FIXTURE_WORKER_EXEC").canonicalize().unwrap(),
    );
    crate::native::owned_process::kill(&handle.into()).unwrap();
}
