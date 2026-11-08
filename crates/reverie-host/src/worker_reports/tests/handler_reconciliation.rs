//! Original actual J/socket/Hold/std thread controls. No fabricated resource
//! completion; a response cannot release another native/lifecycle owner.
use super::*;
use std::sync::mpsc;
fn isolated(name: &str) -> bool {
    crate::test_process::isolate_case(&format!(
        "worker_reports::tests::handler_reconciliation::{name}"
    ))
}
struct Cleanup {
    service: Arc<WorkerReportService>,
    hold: Option<WorkerLaunchHold>,
}
impl Drop for Cleanup {
    fn drop(&mut self) {
        // Release the actual waiter BEFORE attempting its original join on
        // every unwind path. There are no domain resources in this fixture.
        let _ = self.service.reconcile_worker_handlers(end());
        if let Some(hold) = &mut self.hold {
            let _ = hold.release(end());
        }
        let _ = self.service.settle_worker_handlers(end());
        let _ = self.service.close(end());
    }
}
#[test]
fn actual_finalized_reply_cannot_release_the_original_j_hold() {
    if isolated("actual_finalized_reply_cannot_release_the_original_j_hold") {
        return;
    }
    let fixture = Arc::new(Fixture::new());
    let service = Arc::new(fixture.service());
    let (mut client, server) = fixture.sockets();
    send(&mut client, b'J', br#"{"sessionId":"00000000-0000-0000-0000-000000000000","cwd":"/work","command":"echo hello","env":{},"cols":80,"rows":24}"#);
    let mut registered = service.register_worker_connection(server).unwrap();
    let mut constructor = registered.reserve_handler().unwrap();
    let inbox = constructor.retain_reconciliation().unwrap();
    let record = service.records.lock().unwrap()[0].clone();
    let mut cleanup = Cleanup {
        service: service.clone(),
        hold: None,
    };
    let source = fixture.clone();
    let (sent, received) = mpsc::channel();
    let thread = std::thread::spawn(move || {
        let AcceptedWorkerConnection::Launch(connection) = registered
            .receive_for_worker(&source.collector, &super::launch::configuration())
            .unwrap()
        else {
            panic!("actual J");
        };
        let hold = connection.retain_lifecycle().unwrap();
        assert_eq!(
            connection.close_socket_for_worker().unwrap(),
            WorkerLaunchClose::SocketClosedLifecycleHeld
        );
        sent.send(hold).unwrap();
        let request = inbox.receive().unwrap();
        assert_eq!(request.command(), WorkerHandlerCommand::Reconcile);
        request.answer(WorkerHandlerDisposition::Finalized);
    });
    constructor.publish(thread).unwrap();
    cleanup.hold = Some(received.recv_timeout(Duration::from_secs(2)).unwrap());
    assert_eq!(
        service.reconcile_worker_handlers(end()).unwrap(),
        WorkerHandlersProgress::Pending
    );
    service.settle_worker_handlers(end()).unwrap();
    assert_eq!(
        service.reconcile_worker_handlers(end()).unwrap(),
        WorkerHandlersProgress::Pending
    );
    assert!(record.socket_closed_known());
    assert!(!record.settled());
    assert_eq!(service.records.lock().unwrap().len(), 1);
    cleanup.hold.as_mut().unwrap().release(end()).unwrap();
    service.settle_worker_handlers(end()).unwrap();
    service.close(end()).unwrap();
}
#[test]
fn inbox_is_one_shot_and_wrong_actual_thread_cannot_adopt_it() {
    if isolated("inbox_is_one_shot_and_wrong_actual_thread_cannot_adopt_it") {
        return;
    }
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    let (_client, server) = fixture.sockets();
    let mut registered = service.register_worker_connection(server).unwrap();
    let mut constructor = registered.reserve_handler().unwrap();
    let inbox = constructor.retain_reconciliation().unwrap();
    assert!(constructor.retain_reconciliation().is_err());
    assert!(inbox.receive().is_err());
    drop(constructor);
    let _ = registered.close_for_worker();
    assert!(service.close(end()).is_err());
    assert_eq!(service.records.lock().unwrap().len(), 1);
}
