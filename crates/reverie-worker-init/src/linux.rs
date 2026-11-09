use nix::{
    errno::Errno,
    poll::{PollFd, PollFlags, PollTimeout, poll},
    sys::{
        signal::{SigSet, Signal},
        signalfd::{SfdFlags, SignalFd},
        wait::{WaitPidFlag, WaitStatus, waitpid},
    },
    unistd::Pid,
};
use std::{io, os::fd::AsFd};

// Check pending stop signals between bounded nonblocking child-reap batches.
const REAP_BATCH: usize = 256;

pub(super) fn run() -> io::Result<()> {
    validate_invocation(Pid::this().as_raw(), std::env::args_os().count())?;
    let mut mask = SigSet::empty();
    for signal in [Signal::SIGTERM, Signal::SIGINT, Signal::SIGCHLD] {
        mask.add(signal);
    }
    // No threads, children or application code exist in this fixed program.
    // Block before creating the descriptor so an early stop remains pending.
    // Linux sig_ignored explicitly preserves blocked signals even for PID1.
    mask.thread_set_mask().map_err(io::Error::from)?;
    let signals = SignalFd::with_flags(&mask, SfdFlags::SFD_CLOEXEC | SfdFlags::SFD_NONBLOCK)
        .map_err(io::Error::from)?;
    loop {
        if stop_pending(&signals)? {
            // Exiting namespace PID1 makes Linux terminate its remaining
            // members. We do not signal caller-selected PIDs or start a grace
            // timer that could be renewed by more children/signals.
            return Ok(());
        }
        if reap_batch()? {
            continue;
        }
        wait_signal(&signals)?;
    }
}

fn validate_invocation(pid: i32, argument_count: usize) -> io::Result<()> {
    if pid != 1 || argument_count != 1 {
        return Err(io::Error::other("PID1 and no arguments required"));
    }
    Ok(())
}

fn stop_pending(signals: &SignalFd) -> io::Result<bool> {
    // Only three standard (coalesced) signals are in this descriptor's mask.
    // SIGINT/SIGTERM are numerically before SIGCHLD on Linux; draining cannot
    // be starved by an arbitrary queued real-time signal stream.
    for _ in 0..3 {
        let Some(info) = signals.read_signal().map_err(io::Error::from)? else {
            break;
        };
        match Signal::try_from(info.ssi_signo as i32) {
            Ok(Signal::SIGTERM | Signal::SIGINT) => return Ok(true),
            Ok(Signal::SIGCHLD) => (),
            _ => return Err(io::Error::other("unexpected init signal")),
        }
    }
    Ok(false)
}

fn reap_batch() -> io::Result<bool> {
    for _ in 0..REAP_BATCH {
        match waitpid(Pid::from_raw(-1), Some(WaitPidFlag::WNOHANG)) {
            Ok(WaitStatus::Exited(..) | WaitStatus::Signaled(..)) => (),
            Ok(WaitStatus::StillAlive) | Err(Errno::ECHILD) => return Ok(false),
            Err(Errno::EINTR) => (),
            Ok(_) => return Err(io::Error::other("unexpected child wait state")),
            Err(error) => return Err(error.into()),
        }
    }
    Ok(true)
}

fn wait_signal(signals: &SignalFd) -> io::Result<()> {
    let mut descriptors = [PollFd::new(signals.as_fd(), PollFlags::POLLIN)];
    match poll(&mut descriptors, PollTimeout::NONE) {
        Ok(1) if descriptors[0].revents() == Some(PollFlags::POLLIN) => Ok(()),
        Err(Errno::EINTR) => Ok(()),
        Err(error) => Err(error.into()),
        _ => Err(io::Error::other("init signal descriptor unavailable")),
    }
}

#[cfg(test)]
mod tests {
    use super::validate_invocation;

    #[test]
    fn invocation_refuses_non_init_and_every_command_argument() {
        assert!(validate_invocation(1, 1).is_ok());
        for pid in [-1, 0, 2, i32::MAX] {
            assert!(validate_invocation(pid, 1).is_err());
        }
        for count in [0, 2, 3, usize::MAX] {
            assert!(validate_invocation(1, count).is_err());
        }
    }
}
