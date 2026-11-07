//! Private synchronized constructor pause after real PTY/identity preparation.
use crate::captured_client::test_hooks::Gate;
use std::cell::Cell;
use std::{cell::RefCell, sync::Arc};
thread_local! { static NEXT: RefCell<Option<Arc<Gate>>> = const { RefCell::new(None) }; }
thread_local! { static INPUT_CLOSE: Cell<bool> = const { Cell::new(false) }; }
thread_local! { static WRITE: RefCell<Option<Arc<Gate>>> = const { RefCell::new(None) }; }
thread_local! { static BUSY: RefCell<Option<Arc<Gate>>> = const { RefCell::new(None) }; }
thread_local! { static GROUP_FAILURE: Cell<bool> = const { Cell::new(false) }; }
thread_local! { static PROBE_FAILURE: Cell<bool> = const { Cell::new(false) }; }
pub(in crate::worker_laptop) fn next_constructor(gate: Arc<Gate>) {
    NEXT.with(|next| *next.borrow_mut() = Some(gate));
}
pub(super) fn take_gate() -> Option<Arc<Gate>> {
    NEXT.with(|next| next.borrow_mut().take())
}
pub(in crate::worker_laptop) fn refuse_next_input_close() {
    INPUT_CLOSE.set(true);
}
pub(super) fn input_close_failure() -> bool {
    INPUT_CLOSE.replace(false)
}
pub(in crate::worker_laptop) fn next_write(gate: Arc<Gate>) {
    WRITE.with(|next| *next.borrow_mut() = Some(gate));
}
pub(super) fn before_write() {
    if let Some(gate) = WRITE.with(|next| next.borrow_mut().take()) {
        gate.entered
            .store(true, std::sync::atomic::Ordering::Release);
        while !gate.released.load(std::sync::atomic::Ordering::Acquire) {
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    }
}
pub(in crate::worker_laptop) fn observe_busy(gate: Arc<Gate>) {
    BUSY.with(|next| *next.borrow_mut() = Some(gate));
}
pub(super) fn admission_busy() {
    if let Some(gate) = BUSY.with(|next| next.borrow_mut().take()) {
        gate.entered
            .store(true, std::sync::atomic::Ordering::Release);
    }
}
pub(in crate::worker_laptop) fn refuse_next_group_result() {
    GROUP_FAILURE.set(true);
}
pub(in crate::worker_laptop) fn refuse_next_probe_result() {
    PROBE_FAILURE.set(true);
}
pub(super) fn group_failure() -> bool {
    GROUP_FAILURE.replace(false)
}
pub(super) fn probe_failure() -> bool {
    PROBE_FAILURE.replace(false)
}
