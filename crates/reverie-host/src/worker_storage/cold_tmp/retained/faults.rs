//! Fixed owning-test fault positions; no production callback/path/selector.
#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum Fault {
    RetireCollision,
    LostRetireReply,
    InstallCollision,
    LostInstallReply,
    PrepareClose,
    FinishClose,
}
thread_local! {static FAULT: std::cell::Cell<Option<Fault>>=const {std::cell::Cell::new(None)};}
pub(in crate::worker_storage) fn set(fault: Fault) {
    FAULT.with(|value| value.set(Some(fault)));
}
pub(super) fn take(expected: Fault) -> bool {
    FAULT.with(|value| {
        if value.get() == Some(expected) {
            value.set(None);
            true
        } else {
            false
        }
    })
}
