//! Isolated owning test process only; never used by product construction.
use std::{io, mem};
pub(crate) struct Ignored(libc::sigaction);
pub(crate) fn ignore() -> io::Result<Ignored> {
    // SAFETY: fixed SIGCHLD disposition in the caller's exact-one isolated
    // owning subprocess. Save the entire prior action before replacement.
    let mut action: libc::sigaction = unsafe { mem::zeroed() };
    let mut old: libc::sigaction = unsafe { mem::zeroed() };
    action.sa_sigaction = libc::SIG_IGN;
    if unsafe { libc::sigaction(libc::SIGCHLD, &action, &mut old) } == 0 {
        Ok(Ignored(old))
    } else {
        Err(io::Error::last_os_error())
    }
}
impl Drop for Ignored {
    fn drop(&mut self) {
        // SAFETY: restore the complete saved action; no threads are targeted,
        // no pending signals are consumed and no raw PID leaves this owner.
        assert_eq!(
            unsafe { libc::sigaction(libc::SIGCHLD, &self.0, std::ptr::null_mut()) },
            0
        );
    }
}
