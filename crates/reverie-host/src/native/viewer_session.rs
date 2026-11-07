//! Fixed viewer session identity and PTY stdio, never a PID/argv constructor.
//! The service owns SIGCHLD (default disposition, no foreign wait-any reaper).
//! Keep the session leader UNREAPED until the final group-signal decision so
//! its PID/PGID cannot be recycled. No group signal is possible after reap.
#![allow(unsafe_code)]
#[cfg(test)]
pub(crate) mod test_policy;
use super::owned_process::{self as process, Handshake, ProcessStatus};
use std::{
    io, mem,
    os::{
        fd::{AsRawFd, BorrowedFd, OwnedFd},
        unix::process::CommandExt,
    },
    process::{Child, Command},
};

#[derive(Default)]
pub(crate) struct ViewerProcess {
    handshake: Option<Handshake>,
    input: Option<OwnedFd>,
    child: Option<Child>,
    pidfd: Option<OwnedFd>,
    status: Option<ProcessStatus>,
    uncertain: bool,
    attempted: bool,
    #[cfg(test)]
    input_close_failure: bool,
    #[cfg(test)]
    input_closes: usize,
    #[cfg(test)]
    group_dispatches: usize,
}
impl ViewerProcess {
    pub(crate) fn prepare(&mut self, slave: BorrowedFd<'_>) -> io::Result<()> {
        reaping_policy()?;
        self.handshake = Some(Handshake::new().map_err(|error| {
            self.uncertain |= error.close_failed;
            io::Error::other("viewer identity channel preparation failed")
        })?);
        self.input = Some(
            process::reserve_descriptor(slave.try_clone_to_owned()?, 3, process::close).map_err(
                |error| {
                    self.uncertain |= error.close_failed;
                    io::Error::other("viewer PTY descriptor preparation failed")
                },
            )?,
        );
        Ok(())
    }
    pub(crate) fn configure(&self, command: &mut Command) {
        let fd = self.input.as_ref().expect("prepared PTY").as_raw_fd();
        self.handshake
            .as_ref()
            .expect("prepared identity")
            .configure_viewer(command);
        // SAFETY: input is reserved >=3 and owned until spawn returns. All
        // three dup2 targets are fixed stdio; no Command pipe/null setup can
        // overwrite the source. dup2/close are async-signal-safe. The child's
        // original is closed once and checked; exec inherits only 0/1/2 copies.
        unsafe {
            command.pre_exec(move || {
                for target in [libc::STDIN_FILENO, libc::STDOUT_FILENO, libc::STDERR_FILENO] {
                    if libc::dup2(fd, target) < 0 {
                        return Err(io::Error::last_os_error());
                    }
                }
                if libc::close(fd) == 0 {
                    Ok(())
                } else {
                    Err(io::Error::last_os_error())
                }
            });
        }
    }
    pub(crate) fn spawn(&mut self, command: &mut Command) -> io::Result<()> {
        self.attempted = true;
        let result = command.spawn();
        // Publish Child before any fallible parent finalizer. A late constructor
        // still owns this same struct under its registered job mutex.
        match result {
            Ok(child) => self.child = Some(child),
            Err(error) => {
                // An attempted constructor with no returned Child cannot mint
                // a no-start/settled receipt. Preserve the original failure and
                // pending fact even after locally held channel/stdio FDs close.
                self.uncertain = true;
                self.finish_preparation();
                return Err(error);
            }
        }
        self.finish_input();
        let received = self.handshake.as_ref().expect("prepared channel").receive();
        match received {
            Ok(pidfd) => self.pidfd = Some(pidfd),
            Err(error) => self.uncertain |= error.close_failed || self.child.is_some(),
        }
        self.finish_handshake();
        if self.pidfd.is_some() && !self.uncertain {
            Ok(())
        } else {
            Err(io::Error::other(
                "viewer identity or descriptor finalization unconfirmed",
            ))
        }
    }
    fn finish_input(&mut self) {
        if let Some(fd) = self.input.take() {
            self.uncertain |= process::close(fd).is_err();
            #[cfg(test)]
            {
                self.input_closes += 1;
                self.uncertain |= self.input_close_failure;
            }
        }
    }
    fn finish_handshake(&mut self) {
        if let Some(mut channel) = self.handshake.take() {
            self.uncertain |= channel.finish().is_err();
        }
    }
    pub(crate) fn finish_preparation(&mut self) {
        self.finish_input();
        self.finish_handshake();
    }
    pub(crate) fn peek(&self) -> io::Result<Option<ProcessStatus>> {
        if let Some(status) = self.status {
            return Ok(Some(status));
        }
        match self.pidfd.as_ref() {
            Some(fd) => peek(fd),
            None if self.child.is_none() => Ok(None),
            None => Err(io::Error::other("viewer identity missing")),
        }
    }
    pub(crate) fn terminate(&self) -> io::Result<()> {
        self.signal(libc::SIGTERM)
    }
    pub(crate) fn winch(&self) -> io::Result<()> {
        self.signal(libc::SIGWINCH)
    }
    fn signal(&self, signal: i32) -> io::Result<()> {
        if self.status.is_some() {
            return Err(io::ErrorKind::NotConnected.into());
        }
        let fd = self.pidfd.as_ref().ok_or(io::ErrorKind::NotConnected)?;
        // SAFETY: fd belongs to this pre-exec child; null siginfo and zero flags
        // signal exactly that process. Caller can select only TERM or WINCH.
        errno(unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                fd.as_raw_fd(),
                signal,
                std::ptr::null::<libc::siginfo_t>(),
                0u32,
            )
        })
    }
    pub(crate) fn kill_group(&mut self) -> io::Result<()> {
        if self.status.is_some() {
            return Err(io::ErrorKind::NotConnected.into());
        }
        reaping_policy()?;
        // Successful waitid/WNOWAIT also verifies our original child is STILL
        // waitable/live. SIGCHLD default and the service's exclusive child owner
        // forbid an automatic/foreign reap between this check and killpg.
        self.peek()?;
        let child = self.child.as_ref().ok_or(io::ErrorKind::NotConnected)?;
        let group = i32::try_from(child.id()).map_err(|_| io::ErrorKind::InvalidData)?;
        if group <= 1 {
            return Err(io::ErrorKind::InvalidData.into());
        }
        // SAFETY: this private Child was spawned ONLY with setsid before its
        // pidfd handoff. Its unreaped leader pins PID==PGID; no caller PID/name
        // enters here. Session leaders cannot change their own process group.
        #[cfg(test)]
        {
            self.group_dispatches += 1;
        }
        let result = unsafe { libc::kill(-group, libc::SIGKILL) };
        if result == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }
    pub(crate) fn reap(&mut self) -> io::Result<bool> {
        if self.status.is_some() {
            return Ok(true);
        }
        let Some(fd) = self.pidfd.as_ref() else {
            return Ok(self.child.is_none());
        };
        if let Some(status) = process::reap_status(fd)? {
            self.status = Some(status);
            self.child = None;
            // Consuming the descriptor after the terminal transition prevents
            // any later fixed signal. A refused close remains sticky.
            let fd = self.pidfd.take().expect("owned identity");
            self.uncertain |= process::close(fd).is_err();
            Ok(true)
        } else {
            Ok(false)
        }
    }
    pub(crate) fn settled(&self) -> bool {
        !self.uncertain
            && self.child.is_none()
            && self.pidfd.is_none()
            && self.input.is_none()
            && self.handshake.is_none()
    }
    pub(crate) fn handoff_ready(&self) -> bool {
        !self.uncertain
            && self.child.is_some()
            && self.pidfd.is_some()
            && self.status.is_none()
            && self.input.is_none()
            && self.handshake.is_none()
    }
    pub(crate) fn has_pending_native_work(&self) -> bool {
        self.child.is_some()
            || self.pidfd.is_some()
            || self.input.is_some()
            || self.handshake.is_some()
            || (self.attempted && self.status.is_none())
    }
    #[cfg(test)]
    pub(crate) fn refuse_input_close(&mut self) {
        self.input_close_failure = true;
    }
    #[cfg(test)]
    pub(crate) fn external_reap(&self) -> io::Result<Option<ProcessStatus>> {
        process::reap_status(self.pidfd.as_ref().ok_or(io::ErrorKind::NotConnected)?)
    }
    #[cfg(test)]
    pub(crate) fn test_counts(&self) -> (usize, usize) {
        (self.input_closes, self.group_dispatches)
    }
}
fn errno(result: libc::c_long) -> io::Result<()> {
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}
fn reaping_policy() -> io::Result<()> {
    // SAFETY: sigaction with null new-action only reads the live process-wide
    // disposition into initialized writable storage; it does not install one.
    let mut action: libc::sigaction = unsafe { mem::zeroed() };
    errno(unsafe { libc::sigaction(libc::SIGCHLD, std::ptr::null(), &mut action) } as _)?;
    if action.sa_sigaction == libc::SIG_DFL && action.sa_flags & libc::SA_NOCLDWAIT == 0 {
        Ok(())
    } else {
        Err(io::Error::other(
            "viewer requires service-owned SIGCHLD reaping",
        ))
    }
}
fn peek(fd: &OwnedFd) -> io::Result<Option<ProcessStatus>> {
    // SAFETY: owned pidfd targets only our exact child. WNOWAIT deliberately
    // retains its PID/PGID reservation until the final group decision/reap.
    let mut info: libc::siginfo_t = unsafe { mem::zeroed() };
    errno(unsafe {
        libc::waitid(
            libc::P_PIDFD,
            fd.as_raw_fd() as libc::id_t,
            &mut info,
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    } as _)?;
    // SAFETY: successful waitid initializes these documented union accessors.
    if unsafe { info.si_pid() } == 0 {
        return Ok(None);
    }
    let status = unsafe { info.si_status() };
    match info.si_code {
        libc::CLD_EXITED => Ok(Some(ProcessStatus::Exited(
            u8::try_from(status).map_err(|_| io::ErrorKind::InvalidData)?,
        ))),
        libc::CLD_KILLED | libc::CLD_DUMPED if (1..=127).contains(&status) => {
            Ok(Some(ProcessStatus::Signaled(status)))
        }
        _ => Err(io::ErrorKind::InvalidData.into()),
    }
}
