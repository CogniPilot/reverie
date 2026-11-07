//! Purpose-local fault only AFTER consuming the real descriptor exactly once.
use super::*;
use std::{
    cell::{Cell, RefCell},
    sync::{Arc, atomic::Ordering},
};
thread_local! {
    static WRITE_GATE: RefCell<Option<Arc<crate::captured_client::test_hooks::Gate>>>=const {RefCell::new(None)};
    static REFUSE:Cell<usize>=const {Cell::new(0)};
    static COUNT:Cell<usize>=const {Cell::new(0)};
}
pub(in crate::worker_laptop) fn refuse_close(number: usize) {
    COUNT.with(|v| v.set(0));
    REFUSE.with(|v| v.set(number));
}
pub(in crate::worker_laptop) fn count() -> usize {
    COUNT.with(Cell::get)
}
pub(super) fn after_actual_close() -> Result<()> {
    let count = COUNT.with(|v| {
        let count = v.get() + 1;
        v.set(count);
        count
    });
    let refuse = REFUSE.with(|v| {
        if v.get() == count {
            v.set(0);
            true
        } else {
            false
        }
    });
    if refuse {
        Err(LaptopError::Observation(crate::ObservationError::Io(
            std::io::Error::other("owned post-close refusal"),
        )))
    } else {
        Ok(())
    }
}

pub(in crate::worker_laptop) fn hold_after_record_write(
    gate: Arc<crate::captured_client::test_hooks::Gate>,
) {
    WRITE_GATE.with(|slot| *slot.borrow_mut() = Some(gate));
}
pub(super) fn after_record_write() {
    if let Some(gate) = WRITE_GATE.with(|slot| slot.borrow_mut().take()) {
        gate.entered.store(true, Ordering::Release);
        while !gate.released.load(Ordering::Acquire) {
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    }
}
