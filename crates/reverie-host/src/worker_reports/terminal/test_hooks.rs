//! Actual lock-contention staging only, in isolated owning tests. No product
//! clock, authority, descriptor ownership or syscall outcome is substituted.
use crate::captured_client::test_hooks::Gate;
use std::{
    cell::RefCell,
    sync::{Arc, atomic::Ordering},
    time::Duration,
};
thread_local! {
    static INPUT: RefCell<Option<Arc<Gate>>> = const { RefCell::new(None) };
    static BUSY: RefCell<Option<Arc<Gate>>> = const { RefCell::new(None) };
    static PRESSURE: RefCell<Option<Arc<Gate>>> = const { RefCell::new(None) };
}
pub(crate) fn observe_backpressure(gate: Arc<Gate>) {
    PRESSURE.with(|slot| *slot.borrow_mut() = Some(gate));
}
pub(super) fn write_wait(error: &std::io::Error) {
    if error.kind() != std::io::ErrorKind::WouldBlock {
        return;
    }
    if let Some(gate) = PRESSURE.with(|slot| slot.borrow_mut().take()) {
        gate.entered.store(true, Ordering::Release);
    }
}
pub(crate) fn input_contention(input: Arc<Gate>, busy: Arc<Gate>) {
    INPUT.with(|slot| *slot.borrow_mut() = Some(input));
    BUSY.with(|slot| *slot.borrow_mut() = Some(busy));
}
pub(super) fn before_input() {
    if let Some(gate) = INPUT.with(|slot| slot.borrow_mut().take()) {
        gate.entered.store(true, Ordering::Release);
        while !gate.released.load(Ordering::Acquire) {
            std::thread::sleep(Duration::from_millis(1));
        }
    }
}
pub(super) fn saw_busy() {
    if let Some(gate) = BUSY.with(|slot| slot.borrow_mut().take()) {
        gate.entered.store(true, Ordering::Release);
    }
}
