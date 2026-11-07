//! Purpose-private test faults only, after actual owned syscalls have completed.
use std::{cell::Cell, io};
#[derive(Clone, Copy, Default)]
struct State {
    prepare: bool,
    master: bool,
    slave: bool,
    closes: (usize, usize),
}
thread_local! { static FAULTS: Cell<State> = Cell::new(State::default()); }
pub(super) struct Guard(State);
pub(super) fn faults(prepare: bool, master: bool, slave: bool) -> Guard {
    Guard(FAULTS.replace(State {
        prepare,
        master,
        slave,
        closes: (0, 0),
    }))
}
impl Drop for Guard {
    fn drop(&mut self) {
        FAULTS.set(self.0);
    }
}
pub(super) fn closes() -> (usize, usize) {
    FAULTS.get().closes
}
pub(super) fn after_prepared() -> io::Result<()> {
    if FAULTS.get().prepare {
        Err(io::Error::other("injected terminal preparation failure"))
    } else {
        Ok(())
    }
}
pub(super) fn after_master_closed() -> io::Result<()> {
    let mut state = FAULTS.get();
    state.closes.0 += 1;
    FAULTS.set(state);
    if state.master {
        Err(io::Error::other("injected master close failure"))
    } else {
        Ok(())
    }
}
pub(super) fn after_slave_closed() -> io::Result<()> {
    let mut state = FAULTS.get();
    state.closes.1 += 1;
    FAULTS.set(state);
    if state.slave {
        Err(io::Error::other("injected slave close failure"))
    } else {
        Ok(())
    }
}
