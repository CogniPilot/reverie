//! Original-record cleanup through a real denial fence, without fleet consent.
use super::super::tests::end;
use super::*;
use crate::reservation_gate::{AdmissionBounds, PoolTransitionFence};
use reverie_contracts::{reservation_control::PoolTransitionSelection, worker_config};
use reverie_core::{
    operations::{JournalDigest, JournalId},
    worker_wire::WorkerFrameHeader,
};
use reverie_host::worker_reports::{
    AcceptedWorkerConnection, AcceptedWorkerServiceConnection, WorkerActorChannel,
    WorkerHandlersProgress, WorkerLaunchConnection, WorkerLaunchHold, WorkerOriginalHandlersDrain,
};
use std::{
    io::{Read, Write},
    os::unix::net::UnixStream,
    sync::mpsc,
    time::Duration,
};

struct Original {
    _client: UnixStream,
    connection: WorkerLaunchConnection,
    hold: WorkerLaunchHold,
    tail: mpsc::Sender<()>,
}
fn frame(kind: u8, raw: &[u8]) -> (UnixStream, UnixStream) {
    let (mut client, server) = UnixStream::pair().unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    client
        .write_all(
            &WorkerFrameHeader::for_payload(kind, raw.len())
                .unwrap()
                .encode(),
        )
        .unwrap();
    client.write_all(raw).unwrap();
    (client, server)
}
fn original(broker: &InstallingBroker) -> Original {
    let (client, server) = frame(b'J', br#"{"sessionId":"00000000-0000-0000-0000-000000000000","cwd":"/work","command":"echo hello","env":{},"cols":80,"rows":24}"#);
    let mut registered = broker.reports.register_worker_connection(server).unwrap();
    let mut construction = registered.reserve_handler().unwrap();
    let config = broker.configuration().unwrap().configuration().clone();
    let telemetry = broker.telemetry.clone();
    let (sent, received) = mpsc::channel();
    let (tail, finished) = mpsc::channel();
    let thread = std::thread::spawn(move || {
        let AcceptedWorkerConnection::Launch(connection) =
            registered.receive_for_worker(&telemetry, &config).unwrap()
        else {
            panic!("actual J");
        };
        let hold = connection.retain_lifecycle().unwrap();
        sent.send((connection, hold)).unwrap();
        let _ = finished.recv_timeout(Duration::from_secs(10));
    });
    construction.publish(thread).unwrap();
    let (connection, hold) = received.recv_timeout(Duration::from_secs(3)).unwrap();
    Original {
        _client: client,
        connection,
        hold,
        tail,
    }
}
fn fleet(broker: &InstallingBroker) -> (UnixStream, WorkerActorChannel) {
    let (mut client, server) = frame(
        b'Q',
        br#"{"purpose":"resource-fleet-maintenance-v1","version":1}"#,
    );
    let AcceptedWorkerServiceConnection::Service(connection) = broker
        .reports
        .register_worker_connection(server)
        .unwrap()
        .receive_service_for_worker(
            &broker.telemetry,
            broker.configuration().unwrap().configuration(),
        )
        .unwrap()
    else {
        panic!("actual fleet Q");
    };
    let mut channel = connection
        .retain_fleet_maintenance_website_channel(&broker.storage.runtime)
        .ok()
        .unwrap();
    channel.pin_peer().unwrap();
    channel.greet(end()).unwrap();
    let mut greeting = [0; b"FLEET_MAINTENANCE_CHANNEL_V1\n".len()];
    client.read_exact(&mut greeting).unwrap();
    assert_eq!(&greeting, b"FLEET_MAINTENANCE_CHANNEL_V1\n");
    (client, channel)
}
fn fence(broker: &InstallingBroker) -> PoolTransitionFence {
    let config = broker.configuration().unwrap();
    let selection = PoolTransitionSelection::new(
        JournalId::parse("aaaaaaaa-0000-4000-8000-000000000001").unwrap(),
        JournalId::parse("aaaaaaaa-0000-4000-8000-000000000002").unwrap(),
        JournalDigest::parse(&"a".repeat(64)).unwrap(),
        JournalDigest::parse(&"b".repeat(64)).unwrap(),
        JournalDigest::parse(&"c".repeat(64)).unwrap(),
        JournalDigest::parse(&worker_config::config_digest(config.configuration()).to_hex())
            .unwrap(),
    );
    broker
        .resource_reservations()
        .unwrap()
        .unwrap()
        .establish_pool_transition(&selection, AdmissionBounds::default())
        .unwrap()
}
fn target(broker: &InstallingBroker, original: &Original) -> WorkerContainerName {
    WorkerContainerName::for_session(
        broker.configuration().unwrap().envelope().base(),
        original.connection.request().session(),
    )
}
fn finish(
    broker: &InstallingBroker,
    originals: Vec<Original>,
    mut q: WorkerActorChannel,
    mut drain: WorkerOriginalHandlersDrain,
) {
    for mut original in originals {
        original.connection.close_socket(end()).unwrap();
        original.hold.release(end()).unwrap();
        original.tail.send(()).unwrap();
    }
    broker.reports.settle_worker_handlers(end()).unwrap();
    drain
        .interrupt(&q, &broker.reports, &broker.storage.runtime)
        .unwrap();
    assert_eq!(
        drain.settle(&broker.storage.runtime).unwrap(),
        WorkerHandlersProgress::Settled
    );
    drain.into_closed().ok().unwrap();
    q.close_for_worker().unwrap();
    broker.reports.close(end()).unwrap();
    broker.close_command_telemetry(end()).unwrap();
    broker.storage.runtime.close(end()).unwrap();
}
fn trace(tree: &Tree) -> Vec<u8> {
    std::fs::read(tree.root.join("calls.txt")).unwrap_or_default()
}
fn refusal(result: Result<WorkerStopAdmission<'_>, GateError>) -> bool {
    match result {
        Err(_) => true,
        Ok(scope) => {
            scope.abort().unwrap();
            false
        }
    }
}

#[test]
fn original_j_cleanup_owns_fresh_flock_without_opening_the_fleet_fence() {
    crate::test_process::owning_case!(
        original_j_cleanup_owns_fresh_flock_without_opening_the_fleet_fence
    );
    let tree = Tree::new();
    let broker = configured(&tree);
    let original = original(&broker);
    let (_client, q) = fleet(&broker);
    let drain = q
        .retain_other_original_handlers(&broker.reports, &broker.storage.runtime, end())
        .unwrap();
    let mut fence = fence(&broker);
    let pending = tree.root.join("state/resource-reservation-control.pending");
    let bytes = std::fs::read(&pending).unwrap();
    let bound = broker.bind_pool_original_cleanup(&mut fence, &q, &drain);
    let name = target(&broker, &original);
    let config =
        ReservationConfiguration::capture(broker.configuration().unwrap().configuration().clone());
    let scope = broker.admit_original_handler_cleanup(&original.connection, &name);
    let (admitted, busy, denied_while_held, closed) = match scope {
        Ok(scope) => {
            let busy = match AdmissionLock::acquire(&config) {
                Err(error) => error.code() == "RESERVATION_ADMISSION_LOCK_BUSY",
                Ok(mut lock) => {
                    lock.close().unwrap();
                    false
                }
            };
            let denied = broker.admit_ordinary_stop(&name).is_err()
                && broker
                    .resource_reservations()
                    .unwrap()
                    .unwrap()
                    .admit_ordinary_launch(
                        original.connection.request().session(),
                        AdmissionBounds::default(),
                    )
                    .is_err();
            (true, busy, denied, scope.close())
        }
        Err(cause) => (false, false, false, Err(cause)),
    };
    let reopened = AdmissionLock::acquire(&config).and_then(|mut lock| lock.close());
    let ordinary = broker
        .admit_ordinary_stop(&name)
        .err()
        .map(|error| error.code());
    let launch = broker
        .resource_reservations()
        .unwrap()
        .unwrap()
        .admit_ordinary_launch(
            original.connection.request().session(),
            AdmissionBounds::default(),
        )
        .err()
        .map(|error| error.code());
    let unchanged = std::fs::read(&pending).unwrap() == bytes;
    let calls = trace(&tree);
    finish(&broker, vec![original], q, drain);
    bound.unwrap();
    closed.unwrap();
    reopened.unwrap();
    assert!(admitted && busy && denied_while_held && unchanged);
    assert_eq!(ordinary, Some("POOL_TRANSITION_REQUIRES_RECONCILIATION"));
    assert_eq!(launch, Some("POOL_TRANSITION_REQUIRES_RECONCILIATION"));
    assert!(
        calls
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .all(|line| line.starts_with(b"ps\0") || line.starts_with(b"inspect\0"))
    );
}

#[test]
fn late_same_sid_and_foreign_originals_cannot_borrow_fenced_cleanup() {
    crate::test_process::owning_case!(
        late_same_sid_and_foreign_originals_cannot_borrow_fenced_cleanup
    );
    let tree = Tree::new();
    let broker = configured(&tree);
    let other_tree = Tree::new();
    let other = configured(&other_tree);
    let original = original(&broker);
    let (_client, q) = fleet(&broker);
    let drain = q
        .retain_other_original_handlers(&broker.reports, &broker.storage.runtime, end())
        .unwrap();
    let late = self::original(&broker);
    let (_other_client, other_q) = fleet(&other);
    let foreign = self::original(&other);
    let other_drain = other_q
        .retain_other_original_handlers(&other.reports, &other.storage.runtime, end())
        .unwrap();
    let (_late_q_client, mut late_q) = fleet(&broker);
    let mut fence = fence(&broker);
    let pending = tree.root.join("state/resource-reservation-control.pending");
    let bytes = std::fs::read(&pending).unwrap();
    let before = trace(&tree);
    let wrong_q = broker
        .bind_pool_original_cleanup(&mut fence, &late_q, &drain)
        .is_err();
    let wrong_binding = broker
        .bind_pool_original_cleanup(&mut fence, &q, &other_drain)
        .is_err();
    let wrong_broker = other
        .bind_pool_original_cleanup(&mut fence, &other_q, &other_drain)
        .is_err();
    let rejected_before_queries = trace(&tree) == before;
    let bound = broker.bind_pool_original_cleanup(&mut fence, &q, &drain);
    let before = trace(&tree);
    let name = target(&broker, &original);
    let late_refused = refusal(broker.admit_original_handler_cleanup(&late.connection, &name));
    let foreign_refused =
        refusal(broker.admit_original_handler_cleanup(&foreign.connection, &name));
    let other_refused = refusal(other.admit_original_handler_cleanup(&original.connection, &name));
    let repeat = broker
        .bind_pool_original_cleanup(&mut fence, &q, &drain)
        .is_err();
    let unchanged = std::fs::read(&pending).unwrap() == bytes && trace(&tree) == before;
    let same_sid = original.connection.request().session() == late.connection.request().session();
    late_q.close_for_worker().unwrap();
    finish(&broker, vec![original, late], q, drain);
    finish(&other, vec![foreign], other_q, other_drain);
    bound.unwrap();
    assert!(wrong_q && wrong_binding && wrong_broker && repeat && rejected_before_queries);
    assert!(late_refused && foreign_refused && other_refused && same_sid && unchanged);
}
