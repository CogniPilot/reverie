//! Observations of actual socket backpressure and owned mutex contention only.
//! These synchronization flags change no result, clock, descriptor or policy.
use std::{
    cell::RefCell,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
thread_local! {
    static SEND: RefCell<Option<Arc<AtomicBool>>> = const { RefCell::new(None) };
    static LOCK: RefCell<Option<Arc<AtomicBool>>> = const { RefCell::new(None) };
}
pub(in crate::worker_reports) fn bind_send(value: Arc<AtomicBool>) {
    SEND.with(|slot| *slot.borrow_mut() = Some(value));
}
pub(in crate::worker_reports) fn bind_lock(value: Arc<AtomicBool>) {
    LOCK.with(|slot| *slot.borrow_mut() = Some(value));
}
pub(in crate::worker_reports) fn send_wait() {
    SEND.with(|slot| {
        if let Some(value) = slot.borrow().as_ref() {
            value.store(true, Ordering::Release);
        }
    });
}
pub(in crate::worker_reports) fn lock_wait() {
    LOCK.with(|slot| {
        if let Some(value) = slot.borrow().as_ref() {
            value.store(true, Ordering::Release);
        }
    });
}
