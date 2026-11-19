//! Test-only socket for the web Goal launch suites. The engine inventory is
//! synthetic. The G frame, kernel peer, private descriptors and reply are real.
use super::*;
use nix::sys::socket::{MsgFlags, recv};
use reverie_host::worker_reports::WorkerServicePurpose;
use std::{
    io,
    os::{fd::AsRawFd, unix::net::UnixListener},
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
    thread,
};

#[test]
#[ignore = "started by the owned web Goal integration fixture"]
fn serve_web_goal_fixture() {
    let root = PathBuf::from(std::env::var_os("REVERIE_GOAL_FIXTURE_ROOT").unwrap());
    let engine = std::env::var_os("REVERIE_GOAL_FIXTURE_ENGINE");
    let engine = engine
        .as_deref()
        .unwrap_or_else(|| crate::test_process::engine_program().as_os_str());
    let snapshot = load_owner_config(&root.join("worker.json")).unwrap();
    let runtime = WorkerRuntime::new(
        InstalledWorkerEngine::new(
            EngineBootstrap::from_service(engine, BTreeMap::new(), root.clone()).unwrap(),
        ),
        snapshot.envelope().base(),
    );
    let broker = InstallingBroker::new(snapshot, runtime).unwrap();
    let socket = root.join("control/broker.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    fs::set_permissions(&socket, fs::Permissions::from_mode(0o600)).unwrap();
    listener.set_nonblocking(true).unwrap();
    println!("\nREADY");
    io::stdout().flush().unwrap();
    serve_until_stdin_closes(&listener, &broker);
    drop(listener);
    fs::remove_file(socket).unwrap();
    broker.close_command_telemetry(end()).unwrap();
    broker.storage.runtime.close(end()).unwrap();
}

fn serve_until_stdin_closes(listener: &UnixListener, broker: &InstallingBroker) {
    let finished = AtomicBool::new(false);
    thread::scope(|scope| {
        scope.spawn(|| {
            let _ = io::stdin().read(&mut [0]);
            finished.store(true, Ordering::Release);
        });
        while !finished.load(Ordering::Acquire) {
            match listener.accept() {
                Ok((stream, _)) => serve_goal(stream, broker),
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(2));
                }
                Err(error) => panic!("owned Goal fixture accept: {error}"),
            }
        }
    });
}

fn serve_goal(stream: UnixStream, broker: &InstallingBroker) {
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let mut kind = [0];
    if recv(stream.as_raw_fd(), &mut kind, MsgFlags::MSG_PEEK) != Ok(1) || kind != [b'G'] {
        return;
    }
    let current = broker.configuration().unwrap();
    let connection = broker
        .reports
        .register_worker_connection(stream)
        .unwrap()
        .receive_service_for_worker(broker.command_telemetry(), current.configuration())
        .unwrap();
    let AcceptedWorkerServiceConnection::Service(connection) = connection else {
        panic!("owned fixture accepts G only");
    };
    assert_eq!(connection.purpose(), WorkerServicePurpose::GoalCustody);
    broker.handle_goal_custody(connection).unwrap();
}
