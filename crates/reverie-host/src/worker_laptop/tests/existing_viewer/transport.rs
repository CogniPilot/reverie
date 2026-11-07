//! Actual kernel-peer J records, actual employee Box/first-inspect, and the
//! fixed native PTY child. No App admission/stop/global-finalizer completion.
use super::*;
mod bulk;
mod contention;
mod created;
mod diagnostic;
mod identity;
mod receipt;
mod resize;
mod worker;
use crate::worker_reports::{
    ViewerRelay, ViewerRelayEnd, ViewerRelayEvent, WorkerLaunchConnection, WorkerLaunchHold,
    WorkerReportService,
};
use std::{
    io::{Read, Write},
    os::unix::net::UnixStream,
};
fn isolated(name: &str) -> bool {
    crate::test_process::isolate_case(&format!(
        "worker_laptop::tests::existing_viewer::transport::{name}"
    ))
}
fn send(stream: &mut UnixStream, kind: u8, bytes: &[u8]) {
    let header =
        reverie_core::worker_wire::WorkerFrameHeader::for_payload(kind, bytes.len()).unwrap();
    stream.write_all(&header.encode()).unwrap();
    stream.write_all(bytes).unwrap();
}
fn receive(stream: &mut UnixStream) -> (u8, Vec<u8>) {
    let mut raw = [0; 5];
    stream.read_exact(&mut raw).unwrap();
    let header = reverie_core::worker_wire::WorkerFrameHeader::decode(raw);
    let mut bytes = vec![0; header.payload_length() as usize];
    stream.read_exact(&mut bytes).unwrap();
    (header.kind(), bytes)
}
fn accepted(
    fixture: &Fixture,
    service: &Arc<WorkerReportService>,
    command: &str,
) -> (UnixStream, WorkerLaunchConnection, WorkerLaunchHold) {
    fixture.accepted(service, command)
}
fn retained(fixture: &Fixture, connection: &WorkerLaunchConnection) -> ExistingViewer {
    retained_with_path(fixture, connection).0
}
fn retained_with_path(
    fixture: &Fixture,
    connection: &WorkerLaunchConnection,
) -> (ExistingViewer, PathBuf) {
    let (mut storage, plan, _request, inspected) = originals(fixture);
    let receipt = super::relay::receipt(fixture, &mut storage);
    let path = crate::native::python_path(&receipt.exit_path_data().codepoints()).unwrap();
    let existing = fixture
        .runtime()
        .retain_existing_relay_for_connection(storage, plan, inspected, receipt, connection)
        .unwrap_or_else(|error| panic!("{}", error.cause()));
    (existing, path)
}
fn started(
    fixture: &Fixture,
    existing: &ExistingViewer,
    connection: &WorkerLaunchConnection,
) -> ViewerSession {
    let ExistingViewerStart::Started(viewer) = fixture
        .runtime()
        .start_existing_viewer_for_connection(existing, connection, end())
        .unwrap()
    else {
        panic!("genuine source-bound constructor")
    };
    wait(|| fixture.root.join("viewer-ready").is_file());
    viewer
}
fn run(mut relay: ViewerRelay<'_>, fixture: &Fixture) -> ViewerRelayEnd {
    loop {
        match relay.step().unwrap() {
            ViewerRelayEvent::Progress => {}
            ViewerRelayEvent::CheckCurrentIntent => {
                if let ViewerRelayEvent::Ended(reason) =
                    relay.check_current_intent(&fixture.source).unwrap()
                {
                    return reason;
                }
            }
            ViewerRelayEvent::Ended(reason) => return reason,
        }
    }
}
fn cleanup_component(
    fixture: &Fixture,
    existing: &ExistingViewer,
    connection: WorkerLaunchConnection,
    mut hold: WorkerLaunchHold,
    service: &WorkerReportService,
) {
    fixture
        .runtime()
        .close_existing_viewer(existing, end())
        .unwrap();
    let (storage, _plan, _request, _inspection, _receipt, _failure) = fixture
        .runtime()
        .reclaim_existing_relay(existing)
        .unwrap()
        .into_parts();
    connection.close_socket(end()).unwrap();
    hold.release(end())
        .unwrap_or_else(|_| panic!("actual known socket + transferred owner"));
    service.close(end()).unwrap();
    storage.close(end()).unwrap();
}
#[test]
fn actual_j_input_output_and_child_exit_frames_keep_storage_and_native_pin_for_real_finalizer() {
    if isolated(
        "actual_j_input_output_and_child_exit_frames_keep_storage_and_native_pin_for_real_finalizer",
    ) {
        return;
    }
    let fixture = Fixture::employee("created-viewer-echo");
    let service = Arc::new(WorkerReportService::from_runtime(fixture.runtime()));
    let (mut client, connection, hold) = accepted(&fixture, &service, "opencode");
    let existing = retained(&fixture, &connection);
    let viewer = started(&fixture, &existing, &connection);
    let relay = connection
        .begin_viewer_relay(fixture.runtime(), &viewer)
        .unwrap();
    let reason = std::thread::scope(|scope| {
        let worker = scope.spawn(|| run(relay, &fixture));
        send(&mut client, b'I', b"hello");
        let mut output = Vec::new();
        while output != b"hello" {
            let (kind, bytes) = receive(&mut client);
            assert_eq!(kind, b'O');
            output.extend(bytes);
        }
        send(&mut client, b'I', b"Q");
        assert_eq!(receive(&mut client), (b'X', b"7".to_vec()));
        worker.join().unwrap()
    });
    assert!(matches!(reason, ViewerRelayEnd::ViewerExited(7)));
    assert!(StorageLease::acquire_migration(&fixture.source, &sid()).is_err());
    assert!(fixture.runtime().reclaim_existing_relay(&existing).is_err());
    let identity = fs::read_to_string(fixture.root.join("viewer-identity")).unwrap();
    let pid = identity.split_whitespace().next().unwrap();
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).unwrap();
    assert!(
        stat.rsplit_once(") ").unwrap().1.starts_with("Z "),
        "actual owned leader remains unreaped for finalizer"
    );
    assert!(
        connection
            .begin_viewer_relay(fixture.runtime(), &viewer)
            .is_err(),
        "actual transport is one-shot"
    );
    cleanup_component(&fixture, &existing, connection, hold, &service);
}
#[test]
fn second_actual_j_with_same_sid_refuses_before_constructor_and_cannot_take_the_original_relay() {
    if isolated(
        "second_actual_j_with_same_sid_refuses_before_constructor_and_cannot_take_the_original_relay",
    ) {
        return;
    }
    let fixture = Fixture::employee("created-viewer-echo");
    let service = Arc::new(WorkerReportService::from_runtime(fixture.runtime()));
    let (mut first, original, hold) = accepted(&fixture, &service, "opencode");
    let (_second, foreign, mut foreign_hold) = accepted(&fixture, &service, "different-command");
    let existing = retained(&fixture, &original);
    assert!(
        fixture
            .runtime()
            .start_existing_viewer_for_connection(&existing, &foreign, end())
            .is_err()
    );
    assert!(
        fixture
            .runtime()
            .start_existing_viewer(&existing, end())
            .is_err()
    );
    assert!(!fixture.root.join("viewer-ready").exists());
    let viewer = started(&fixture, &existing, &original);
    assert!(
        foreign
            .begin_viewer_relay(fixture.runtime(), &viewer)
            .is_err()
    );
    let relay = original
        .begin_viewer_relay(fixture.runtime(), &viewer)
        .unwrap();
    let reason = std::thread::scope(|scope| {
        let worker = scope.spawn(|| run(relay, &fixture));
        send(&mut first, b'I', b"Q");
        assert_eq!(receive(&mut first), (b'X', b"7".to_vec()));
        worker.join().unwrap()
    });
    assert!(matches!(reason, ViewerRelayEnd::ViewerExited(7)));
    foreign.close_socket(end()).unwrap();
    foreign_hold
        .release(end())
        .unwrap_or_else(|_| panic!("foreign exact own hold"));
    cleanup_component(&fixture, &existing, original, hold, &service);
}
