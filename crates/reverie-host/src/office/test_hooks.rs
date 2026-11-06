//! Compile-time-only construction fault points. No request/environment switch
//! is present in production; real sockets/descriptors remain the test owners.
use std::{cell::Cell, io};
#[derive(Clone, Copy, Eq, PartialEq)]
pub(super) enum Failure {
    Runtime,
    BeforeAnchor,
    AfterAnchor,
    Spawn,
}
thread_local! { static NEXT: Cell<Option<Failure>> = const { Cell::new(None) }; }
pub(super) fn set(failure: Failure) {
    NEXT.with(|state| state.set(Some(failure)));
}
pub(super) fn fail(failure: Failure) -> io::Result<()> {
    NEXT.with(|state| {
        if state.get() == Some(failure) {
            state.set(None);
            Err(io::Error::other("owned Office construction failure"))
        } else {
            Ok(())
        }
    })
}
