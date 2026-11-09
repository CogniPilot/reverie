//! Actual counted sockets and credentials; no Node/program/action authority.
use super::*;
use reverie_contracts::human_protocol::HumanFrame;
mod ancestry;
mod budgets;
mod pool_registration;
mod pool_registration_pin;
mod process_snapshot;
mod resource_journal;

fn accepted(
    fixture: &Fixture,
    service: &Arc<WorkerReportService>,
    server: UnixStream,
) -> WorkerServiceConnection {
    let AcceptedWorkerServiceConnection::Service(connection) = service
        .register_worker_connection(server)
        .unwrap()
        .receive_service_for_worker(&fixture.collector, &super::launch::configuration())
        .unwrap()
    else {
        panic!("actual Q service record")
    };
    connection
}
fn channel(
    fixture: &Fixture,
    service: &Arc<WorkerReportService>,
) -> (UnixStream, WorkerActorChannel) {
    channel_with_payload(
        fixture,
        service,
        br#"{"purpose":"resource-replacement-v1","version":1}"#,
    )
}
fn channel_with_payload(
    fixture: &Fixture,
    service: &Arc<WorkerReportService>,
    payload: &[u8],
) -> (UnixStream, WorkerActorChannel) {
    let (mut client, server) = fixture.sockets();
    send(&mut client, b'Q', payload);
    let mut channel = accepted(fixture, service, server)
        .retain_resource_website_channel(&fixture.runtime)
        .ok()
        .unwrap();
    channel.pin_peer().unwrap();
    channel.greet(end()).unwrap();
    let mut greeting = [0; 15];
    client.read_exact(&mut greeting).unwrap();
    assert_eq!(&greeting, b"RESOURCE_READY\n");
    (client, channel)
}
#[test]
fn channel_keeps_actual_record_and_kernel_peer_across_fragmented_frames() {
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    let (mut client, mut channel) = channel(&fixture, &service);
    assert_eq!(channel.peer().pid(), std::process::id() as i32);
    assert_eq!(
        channel.request_bytes(),
        br#"{"purpose":"resource-replacement-v1","version":1}"#
    );
    assert_eq!(service.records.lock().unwrap().len(), 1);
    for bytes in [b"\0".as_slice(), b"\0\0\x02", b"{}"] {
        client.write_all(bytes).unwrap();
        assert_eq!(channel.receive_chunk(bytes.len(), end()).unwrap(), bytes);
    }
    channel
        .send_frame(
            &HumanFrame::decode_canonical(br#"{"kind":"fixture"}"#).unwrap(),
            end(),
        )
        .unwrap();
    let mut prefix = [0; 4];
    client.read_exact(&mut prefix).unwrap();
    let mut body = vec![0; u32::from_be_bytes(prefix) as usize];
    client.read_exact(&mut body).unwrap();
    assert_eq!(body, br#"{"kind":"fixture"}"#);
    assert!(!channel.peer_ended().unwrap());
    super::super::record::close(client).unwrap();
    assert!(
        channel.peer_ended().unwrap(),
        "positive socket EOF, not PID DATA"
    );
    channel.close_for_worker().unwrap();
    assert!(service.records.lock().unwrap().is_empty());
    service.close(end()).unwrap();
}
#[test]
fn checked_disconnect_closes_only_socket_and_keeps_original_lifecycle_hold_counted() {
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    let (mut client, mut channel) = channel(&fixture, &service);
    let original = service.records.lock().unwrap()[0].clone();
    assert!(matches!(
        channel.disconnect_for_worker().unwrap(),
        WorkerLaunchClose::SocketClosedLifecycleHeld
    ));
    assert_eq!(client.read(&mut [0]).unwrap(), 0);
    original.require_terminal_hold().unwrap();
    let records = service.records.lock().unwrap();
    assert_eq!(records.len(), 1);
    assert!(Arc::ptr_eq(&records[0], &original));
    drop(records);
    assert!(
        channel
            .send_frame(&HumanFrame::decode_canonical(b"{}").unwrap(), end())
            .is_err()
    );
    channel.close_for_worker().unwrap();
    assert!(service.records.lock().unwrap().is_empty());
    service.close(end()).unwrap();
}
#[test]
fn wrong_runtime_is_refused_before_hold_and_returns_original_connection() {
    let fixture = Fixture::new();
    let foreign = Fixture::new();
    let service = Arc::new(fixture.service());
    let (mut client, server) = fixture.sockets();
    send(&mut client, b'Q', b"{}");
    let mut failure = accepted(&fixture, &service, server)
        .retain_resource_website_channel(&foreign.runtime)
        .err()
        .unwrap();
    assert!(matches!(failure.cause(), WorkerReportError::Peer));
    let records = service.records.lock().unwrap();
    assert_eq!(records.len(), 1);
    assert!(matches!(
        *records[0]
            .lifecycle_until(&super::super::budget::CleanupBudget::bounded(
                &service,
                end()
            ))
            .unwrap(),
        super::super::retention::LifecycleHoldState::Unissued
    ));
    drop(records);
    failure.close_for_worker().unwrap();
    assert!(service.records.lock().unwrap().is_empty());
    service.close(end()).unwrap();
}
#[test]
fn invalid_chunk_latches_forward_failure_and_checked_close_uncertainty() {
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    let (_client, mut channel) = channel(&fixture, &service);
    assert!(channel.receive_chunk(8193, end()).is_err());
    assert!(
        channel
            .send_frame(&HumanFrame::decode_canonical(b"{}").unwrap(), end())
            .is_err()
    );
    CLOSE_REFUSAL.with(|flag| flag.set(true));
    assert!(channel.close_for_worker().is_err());
    assert!(channel.close_for_worker().is_err());
    assert!(service.close(end()).is_err());
    assert_eq!(service.records.lock().unwrap().len(), 1);
}
#[test]
fn transferred_socket_rejects_a_real_different_process_writer() {
    use crate::native::owned_process::RegistrationInput;
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    let (client, mut channel) = channel(&fixture, &service);
    let input = RegistrationInput::prepare(client.into()).ok().unwrap();
    let mut command = std::process::Command::new(std::env::current_exe().unwrap());
    command.args([
        "--exact",
        "worker_reports::tests::resume_channel::foreign_writer_child",
        "--ignored",
    ]);
    command.env("REVERIE_CHANNEL_WRITER_FIXTURE", "owned");
    command
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    input.configure(&mut command);
    let mut child = command.spawn().unwrap();
    let closed = input.finish();
    let received = channel.receive_chunk(64, end());
    let status = reap(&mut child);
    let finished = channel.close_for_worker();
    assert!(closed.is_ok());
    assert!(
        matches!(received, Err(WorkerReportError::Io(error)) if error.kind()==std::io::ErrorKind::PermissionDenied)
    );
    assert!(status.success());
    assert!(finished.is_ok());
    assert!(service.records.lock().unwrap().is_empty());
    service.close(end()).unwrap();
}
fn reap(child: &mut std::process::Child) -> std::process::ExitStatus {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            return child.wait().unwrap();
        }
        std::thread::sleep(Duration::from_millis(1));
    }
}
#[test]
#[ignore = "fixed owned subprocess helper; invoked by actual writer control"]
fn foreign_writer_child() {
    use std::os::fd::AsFd;
    assert_eq!(
        std::env::var("REVERIE_CHANNEL_WRITER_FIXTURE").unwrap(),
        "owned"
    );
    let stdin = std::io::stdin();
    let fd = stdin.as_fd().try_clone_to_owned().unwrap();
    let mut stream = UnixStream::from(fd);
    stream
        .write_all(b"actual different process writer")
        .unwrap();
    super::super::record::close(stream).unwrap();
}
