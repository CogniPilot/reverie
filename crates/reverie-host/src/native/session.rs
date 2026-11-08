//! A child started as the leader of a new session with no blocked signals,
//! for `lease run` (Python `Popen(start_new_session=True)`).
use std::io;
use std::os::unix::process::CommandExt;
use std::process::{Child, Command};

pub(crate) fn spawn_new_session(command: &mut Command) -> io::Result<Child> {
    // SAFETY: setsid and sigprocmask are async-signal-safe and neither
    // allocate nor lock. The empty mask is a local value. The parent may block
    // the signals it forwards; the command must not inherit that mask.
    unsafe {
        command.pre_exec(|| {
            let mut empty: libc::sigset_t = std::mem::zeroed();
            if libc::setsid() < 0
                || libc::sigemptyset(&raw mut empty) != 0
                || libc::sigprocmask(libc::SIG_SETMASK, &raw const empty, std::ptr::null_mut()) != 0
            {
                Err(io::Error::last_os_error())
            } else {
                Ok(())
            }
        });
    }
    command.spawn()
}
