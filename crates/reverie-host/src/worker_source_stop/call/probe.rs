//! A one-shot observation of an ACTUAL typed pre-admission failure. This never
//! changes admission, time, native results or resource ownership.
use std::{
    cell::RefCell,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
thread_local! { static NEXT: RefCell<Option<Arc<AtomicBool>>> = const { RefCell::new(None) }; }
pub(in crate::worker_source_stop) fn observe_next(probe: Arc<AtomicBool>) {
    NEXT.with(|next| {
        assert!(next.borrow().is_none());
        *next.borrow_mut() = Some(probe);
    });
}
pub(super) fn observed() {
    if let Some(probe) = NEXT.with(|next| next.borrow_mut().take()) {
        probe.store(true, Ordering::Release);
    }
}
