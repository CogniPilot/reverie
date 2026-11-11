//! Original counted Q/J records and native sockets; no fleet or resource grant.
use super::*;
use std::rc::Rc;
use std::sync::mpsc;
mod cleanup_binding;

fn isolated(name: &str) -> bool {
    crate::test_process::isolate_case(&format!(
        "worker_reports::tests::resume_channel::other_handlers_drain::{name}"
    ))
}
fn shutdowns() -> usize {
    crate::worker_reports::wire::SHUTDOWNS.with(std::cell::Cell::get)
}
fn socket_live(client: &mut UnixStream) -> bool {
    client.set_nonblocking(true).unwrap();
    let result = client.read(&mut [0]);
    client.set_nonblocking(false).unwrap();
    matches!(result, Err(error) if error.kind() == std::io::ErrorKind::WouldBlock)
}
fn fleet_channel(
    fixture: &Fixture,
    service: &Arc<WorkerReportService>,
) -> (UnixStream, WorkerActorChannel) {
    let (mut client, server) = fixture.sockets();
    send(
        &mut client,
        b'Q',
        br#"{"purpose":"resource-fleet-maintenance-v1","version":1,"replyVersion":2}"#,
    );
    let mut channel = accepted(fixture, service, server)
        .retain_fleet_maintenance_website_channel(&fixture.runtime)
        .ok()
        .unwrap();
    channel.pin_peer().unwrap();
    channel.greet(end()).unwrap();
    let mut greeting = [0; b"FLEET_MAINTENANCE_CHANNEL_V2\n".len()];
    client.read_exact(&mut greeting).unwrap();
    assert_eq!(&greeting, b"FLEET_MAINTENANCE_CHANNEL_V2\n");
    (client, channel)
}

struct Published {
    client: UnixStream,
    connection: WorkerLaunchConnection,
    hold: WorkerLaunchHold,
    release: mpsc::Sender<()>,
    reconciled: mpsc::Receiver<()>,
}
fn published(fixture: &Arc<Fixture>, service: &Arc<WorkerReportService>) -> Published {
    let (mut client, server) = fixture.sockets();
    send(&mut client, b'J', br#"{"sessionId":"00000000-0000-0000-0000-000000000000","cwd":"/work","command":"echo hello","env":{},"cols":80,"rows":24}"#);
    let mut registered = service.register_worker_connection(server).unwrap();
    let mut construction = registered.reserve_handler().unwrap();
    let inbox = construction.retain_reconciliation().unwrap();
    let (sent, received) = mpsc::channel();
    let (release, released) = mpsc::channel();
    let (ack, reconciled) = mpsc::channel();
    let source = fixture.clone();
    let thread = std::thread::spawn(move || {
        let AcceptedWorkerConnection::Launch(connection) = registered
            .receive_for_worker(&source.collector, &super::super::launch::configuration())
            .unwrap()
        else {
            panic!("actual published J")
        };
        let hold = connection.retain_lifecycle().unwrap();
        sent.send((connection, hold)).unwrap();
        let request = inbox.receive().unwrap();
        assert_eq!(request.command(), WorkerHandlerCommand::Reconcile);
        request.answer(WorkerHandlerDisposition::Finalized);
        ack.send(()).unwrap();
        let _ = released.recv_timeout(Duration::from_secs(5));
    });
    construction.publish(thread).unwrap();
    let (connection, hold) = received.recv_timeout(Duration::from_secs(2)).unwrap();
    Published {
        client,
        connection,
        hold,
        release,
        reconciled,
    }
}

#[test]
fn same_originals_interrupt_once_join_and_hold_after_q_closes() {
    if isolated("same_originals_interrupt_once_join_and_hold_after_q_closes") {
        return;
    }
    let fixture = Arc::new(Fixture::new());
    let service = Arc::new(fixture.service());
    let (mut q_client, mut q) = fleet_channel(&fixture, &service);
    let mut original = published(&fixture, &service);
    let record = service.records.lock().unwrap()[1].clone();
    let mut owner = q
        .retain_other_original_handlers(&service, &fixture.runtime, end())
        .unwrap();
    let before = shutdowns();
    let interrupted = owner.interrupt(&q, &service, &fixture.runtime);
    let after_interrupt = shutdowns();
    let duplicate = owner.interrupt(&q, &service, &fixture.runtime);
    let after_duplicate = shutdowns();
    let original_eof = original.client.read(&mut [0]);
    let q_alive = socket_live(&mut q_client);
    let pending = owner.settle(&fixture.runtime);
    original
        .reconciled
        .recv_timeout(Duration::from_secs(2))
        .unwrap();
    original.connection.close_socket(end()).unwrap();
    q.close_for_worker().unwrap();
    let join_bound = owner.deadline(&fixture.runtime).unwrap();
    original.release.send(()).unwrap();
    while !record.handler_job().unwrap().unwrap().known_settled() && Instant::now() < join_bound {
        let _ = owner.settle(&fixture.runtime);
        std::thread::sleep(Duration::from_millis(1));
    }
    let joined_by_owner = record.handler_job().unwrap().unwrap().known_settled();
    let held = owner.settle(&fixture.runtime);
    service.settle_worker_handlers(end()).unwrap();
    original.hold.release(end()).unwrap();
    let settled = owner.settle(&fixture.runtime);
    let final_observation = owner.into_closed().ok().unwrap();
    service.close(end()).unwrap();
    assert!(interrupted.is_ok() && duplicate.is_ok());
    assert_eq!(after_interrupt - before, 1);
    assert_eq!(after_duplicate, after_interrupt);
    assert_eq!(original_eof.unwrap(), 0);
    assert!(q_alive);
    assert!(joined_by_owner);
    assert_eq!(pending.unwrap(), WorkerHandlersProgress::Pending);
    assert_eq!(held.unwrap(), WorkerHandlersProgress::Pending);
    assert_eq!(settled.unwrap(), WorkerHandlersProgress::Settled);
    assert!(final_observation.primary_error().is_none());
    assert!(final_observation.cleanup_error().is_none());
}

#[test]
fn foreign_or_expired_admission_issues_zero_shutdowns_and_preserves_originals() {
    if isolated("foreign_or_expired_admission_issues_zero_shutdowns_and_preserves_originals") {
        return;
    }
    let fixture = Fixture::new();
    let other = Fixture::new();
    let service = Arc::new(fixture.service());
    let foreign = Arc::new(fixture.service());
    let (_q_client, mut q) = fleet_channel(&fixture, &service);
    let (mut client, connection) = super::super::launch::launch(&service, &fixture);
    let before = shutdowns();
    let wrong_service = q.retain_other_original_handlers(&foreign, &fixture.runtime, end());
    let wrong_runtime = q.retain_other_original_handlers(&service, &other.runtime, end());
    let mut owner = q
        .retain_other_original_handlers(&service, &fixture.runtime, end())
        .unwrap();
    let wrong_effect = owner.interrupt(&q, &foreign, &fixture.runtime);
    let mut expired = q
        .retain_other_original_handlers(&service, &fixture.runtime, Instant::now())
        .unwrap();
    let refused = expired.interrupt(&q, &service, &fixture.runtime);
    let after = shutdowns();
    let live = socket_live(&mut client);
    connection.close(end()).unwrap();
    q.close_for_worker().unwrap();
    let _ = owner.settle(&fixture.runtime);
    let _ = expired.settle(&fixture.runtime);
    service.close(end()).unwrap();
    assert!(wrong_service.is_err() && wrong_runtime.is_err() && wrong_effect.is_err());
    assert!(refused.is_err());
    assert_eq!(after, before);
    assert!(live);
}

#[test]
fn fresh_undecided_record_is_not_recaptured_or_interrupted() {
    if isolated("fresh_undecided_record_is_not_recaptured_or_interrupted") {
        return;
    }
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    let (_q_client, mut q) = fleet_channel(&fixture, &service);
    let mut owner = q
        .retain_other_original_handlers(&service, &fixture.runtime, end())
        .unwrap();
    let fleet_alone = q.fleet_other_original_handlers_settled(&service);
    let interrupted = owner.interrupt(&q, &service, &fixture.runtime);
    let (mut client, server) = fixture.sockets();
    let registered = service.register_worker_connection(server).unwrap();
    let before = shutdowns();
    let fresh_pending = owner.settle(&fixture.runtime);
    let duplicate = owner.interrupt(&q, &service, &fixture.runtime);
    let after = shutdowns();
    let live = socket_live(&mut client);
    drop(registered);
    let settled = owner.settle(&fixture.runtime);
    owner.into_closed().ok().unwrap();
    q.close_for_worker().unwrap();
    service.close(end()).unwrap();
    assert!(interrupted.is_ok() && duplicate.is_ok());
    assert!(fleet_alone.unwrap());
    assert_eq!(fresh_pending.unwrap(), WorkerHandlersProgress::Pending);
    assert_eq!(settled.unwrap(), WorkerHandlersProgress::Settled);
    assert_eq!(before, after);
    assert!(live);
}

#[test]
fn consumed_original_close_retains_same_cleanup_cause_without_replay() {
    if isolated("consumed_original_close_retains_same_cleanup_cause_without_replay") {
        return;
    }
    let fixture = Arc::new(Fixture::new());
    let service = Arc::new(fixture.service());
    let (_q_client, mut q) = fleet_channel(&fixture, &service);
    let mut original = published(&fixture, &service);
    let mut owner = q
        .retain_other_original_handlers(&service, &fixture.runtime, end())
        .unwrap();
    owner.interrupt(&q, &service, &fixture.runtime).unwrap();
    let _ = owner.settle(&fixture.runtime);
    original
        .reconciled
        .recv_timeout(Duration::from_secs(2))
        .unwrap();
    CLOSE_REFUSAL.with(|flag| flag.set(true));
    let closed = original.connection.close_socket(end());
    original.release.send(()).unwrap();
    let _ = service.settle_worker_handlers(end());
    let hold_retained = original.hold.release(end());
    let first = owner.settle(&fixture.runtime).unwrap_err();
    let before = shutdowns();
    let second = owner.settle(&fixture.runtime).unwrap_err();
    let replay = owner.interrupt(&q, &service, &fixture.runtime);
    let after = shutdowns();
    let preserved = owner
        .cleanup_error()
        .is_some_and(|cause| Rc::ptr_eq(cause, &first));
    let retained = owner.into_closed().is_err();
    q.close_for_worker().unwrap();
    let whole = service.close(end());
    assert!(closed.is_err() && hold_retained.is_err() && whole.is_err());
    assert!(Rc::ptr_eq(&first, &second) && preserved && retained);
    assert!(replay.is_err());
    assert_eq!(before, after);
}

#[test]
fn poisoned_registry_is_unknown_and_never_dispatches_shutdown() {
    if isolated("poisoned_registry_is_unknown_and_never_dispatches_shutdown") {
        return;
    }
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    let (_q_client, q) = fleet_channel(&fixture, &service);
    let mut owner = q
        .retain_other_original_handlers(&service, &fixture.runtime, end())
        .unwrap();
    let original = service.clone();
    let poisoned = std::thread::spawn(move || {
        let _held = original.records.lock().unwrap();
        panic!("actual original registry poison control");
    })
    .join();
    let before = shutdowns();
    let interrupted = owner.interrupt(&q, &service, &fixture.runtime);
    let after = shutdowns();
    let settlement = owner.settle(&fixture.runtime);
    let retained = owner.into_closed().is_err();
    let whole = service.close(end());
    assert!(poisoned.is_err() && interrupted.is_err() && settlement.is_err());
    assert!(retained && whole.is_err());
    assert_eq!(before, after);
}

#[test]
fn original_control_contention_is_pending_then_issued_once_after_release() {
    if isolated("original_control_contention_is_pending_then_issued_once_after_release") {
        return;
    }
    let fixture = Arc::new(Fixture::new());
    let service = Arc::new(fixture.service());
    let (_q_client, mut q) = fleet_channel(&fixture, &service);
    let mut original = published(&fixture, &service);
    let record = service.records.lock().unwrap()[1].clone();
    let mut owner = q
        .retain_other_original_handlers(&service, &fixture.runtime, end())
        .unwrap();
    let held = record.test_control_guard();
    let before = shutdowns();
    let pending = owner.interrupt(&q, &service, &fixture.runtime);
    let while_held = shutdowns();
    let socket_still_live = socket_live(&mut original.client);
    drop(held);
    let issued = owner.interrupt(&q, &service, &fixture.runtime);
    let after_release = shutdowns();
    let duplicate = owner.interrupt(&q, &service, &fixture.runtime);
    let after_duplicate = shutdowns();
    let _ = owner.settle(&fixture.runtime);
    original
        .reconciled
        .recv_timeout(Duration::from_secs(2))
        .unwrap();
    original.connection.close_socket(end()).unwrap();
    original.release.send(()).unwrap();
    service.settle_worker_handlers(end()).unwrap();
    original.hold.release(end()).unwrap();
    let settled = owner.settle(&fixture.runtime);
    owner.into_closed().ok().unwrap();
    q.close_for_worker().unwrap();
    service.close(end()).unwrap();
    assert_eq!(pending.unwrap(), WorkerHandlersProgress::Pending);
    assert!(socket_still_live);
    assert_eq!(while_held, before);
    assert!(issued.is_ok() && duplicate.is_ok());
    assert_eq!(after_release - before, 1);
    assert_eq!(after_duplicate, after_release);
    assert_eq!(settled.unwrap(), WorkerHandlersProgress::Settled);
}

#[test]
fn actual_first_stop_after_capture_clips_original_deadline_and_denies_new_shutdown() {
    if isolated("actual_first_stop_after_capture_clips_original_deadline_and_denies_new_shutdown") {
        return;
    }
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    let (_q_client, mut q) = fleet_channel(&fixture, &service);
    let (mut client, connection) = super::super::launch::launch(&service, &fixture);
    let original_end = Instant::now() + Duration::from_secs(120);
    let mut owner = q
        .retain_other_original_handlers(&service, &fixture.runtime, original_end)
        .unwrap();
    let captured = owner.deadline(&fixture.runtime);
    let first_stop = fixture.runtime.request_stop();
    let observed = owner.deadline(&fixture.runtime);
    let before = shutdowns();
    let interrupted = owner.interrupt(&q, &service, &fixture.runtime);
    let after = shutdowns();
    let live = socket_live(&mut client);
    connection.close_socket_for_worker().unwrap();
    q.close_for_worker().unwrap();
    let _ = owner.settle(&fixture.runtime);
    service.close(end()).unwrap();
    assert_eq!(captured.unwrap(), original_end);
    assert!(first_stop < original_end);
    assert_eq!(observed.unwrap(), first_stop);
    assert!(interrupted.is_err() && live);
    assert_eq!(before, after);
}

#[test]
fn fleet_channel_rejects_ram_and_nonclosed_hellos_before_hold_or_effects() {
    if isolated("fleet_channel_rejects_ram_and_nonclosed_hellos_before_hold_or_effects") {
        return;
    }
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    let mut outcomes = Vec::new();
    for raw in [
        br#"{"purpose":"resource-ram-pool-v2","version":2}"#.as_slice(),
        br#"{"purpose":"resource-fleet-maintenance-v1","version":1,"extra":true}"#,
        br#"{"purpose":"resource-fleet-maintenance-v1","version":1,"version":1}"#,
        br#"{"purpose":"resource-fleet-maintenance-v1","version":1.0}"#,
    ] {
        let (mut client, server) = fixture.sockets();
        send(&mut client, b'Q', raw);
        let before = shutdowns();
        let mut failure = accepted(&fixture, &service, server)
            .retain_fleet_maintenance_website_channel(&fixture.runtime)
            .err()
            .unwrap();
        let original_typed_cause = matches!(failure.cause(), WorkerReportError::FleetHello(_));
        let no_effect = shutdowns() == before && socket_live(&mut client);
        let closed = failure.close_for_worker();
        outcomes.push((original_typed_cause, no_effect, closed));
    }
    let (_ram_client, mut ram) = channel(&fixture, &service);
    let before = shutdowns();
    let refused = ram.retain_other_original_handlers(&service, &fixture.runtime, end());
    let wrong_observer = ram.fleet_other_original_handlers_settled(&service);
    let no_ram_effect = shutdowns() == before;
    ram.close_for_worker().unwrap();
    service.close(end()).unwrap();
    assert!(refused.is_err() && wrong_observer.is_err() && no_ram_effect);
    assert!(
        outcomes
            .into_iter()
            .all(|(typed, no_effect, closed)| typed && no_effect && closed.is_ok())
    );
}
