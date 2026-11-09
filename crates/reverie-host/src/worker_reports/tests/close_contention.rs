use super::*;
use std::sync::mpsc::{self, Sender};

thread_local! {
    static LOCK_WAIT: RefCell<Option<Sender<()>>> = const { RefCell::new(None) };
}

pub(super) fn lock_contended() {
    if let Some(waiting) = LOCK_WAIT.with(|slot| slot.borrow_mut().take()) {
        let _ = waiting.send(());
    }
}
pub(super) fn observe_lock(waiting: Sender<()>) {
    LOCK_WAIT.with(|slot| *slot.borrow_mut() = Some(waiting));
}

fn closes_after_observed_contention(handler: bool) {
    let fixture = Fixture::new();
    let service = fixture.service();
    let (_client, server) = fixture.sockets();
    let record = service.admit(server).unwrap();
    record
        .finish_launch(&budget::CleanupBudget::bounded(&service, end()))
        .unwrap();
    std::thread::scope(|scope| {
        let handler_lock;
        let lifecycle_lock;
        if handler {
            handler_lock = Some(record.handler.lock().unwrap());
            lifecycle_lock = None;
        } else {
            handler_lock = None;
            lifecycle_lock = Some(
                record
                    .lifecycle_until(&budget::CleanupBudget::bounded(&service, end()))
                    .unwrap(),
            );
        }
        let (waiting, observed) = mpsc::channel();
        let held = &service;
        let task = scope.spawn(move || {
            observe_lock(waiting);
            held.close(end())
        });
        // The observer fires only after an actual try_lock reports contention.
        // No sleep or thread scheduling assumption creates this overlap.
        observed.recv_timeout(Duration::from_secs(2)).unwrap();
        drop(handler_lock);
        drop(lifecycle_lock);
        task.join().unwrap().unwrap();
    });
    assert!(service.records.lock().unwrap().is_empty());
    service.close(end()).unwrap();
}

#[test]
fn close_waits_for_actual_handler_bookkeeping_contention() {
    closes_after_observed_contention(true);
}

#[test]
fn close_waits_for_actual_lifecycle_bookkeeping_contention() {
    closes_after_observed_contention(false);
}

#[test]
fn bookkeeping_waits_cannot_renew_expired_first_stop_or_forget_the_record() {
    for handler in [true, false] {
        let fixture = Fixture::new();
        let service = fixture.service();
        let (_client, server) = fixture.sockets();
        let record = service.admit(server).unwrap();
        record
            .finish_launch(&budget::CleanupBudget::bounded(&service, end()))
            .unwrap();
        let handler_lock;
        let lifecycle_lock;
        if handler {
            handler_lock = Some(record.handler.lock().unwrap());
            lifecycle_lock = None;
        } else {
            handler_lock = None;
            lifecycle_lock = Some(
                record
                    .lifecycle_until(&budget::CleanupBudget::bounded(&service, end()))
                    .unwrap(),
            );
        }
        service.engine.expire_stop_for_owned_test();
        let start = Instant::now();
        match service.close(end()).unwrap_err() {
            WorkerReportError::Unconfirmed => {}
            WorkerReportError::Finalization { primary, secondary } => {
                assert!(matches!(*primary, WorkerReportError::Unconfirmed));
                assert!(matches!(*secondary, WorkerReportError::Unconfirmed));
            }
            other => panic!("unexpected cleanup refusal: {other:?}"),
        }
        assert!(start.elapsed() < Duration::from_millis(500));
        assert_eq!(service.records.lock().unwrap().len(), 1);
        assert!(!record.opaque(), "observation consumed no resource");
        drop(handler_lock);
        drop(lifecycle_lock);
        service.close(end()).unwrap();
        assert!(service.records.lock().unwrap().is_empty());
    }
}
