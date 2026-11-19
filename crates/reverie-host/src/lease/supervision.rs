//! Forward terminal signals to a leased session and verify when its group is gone.
use super::spawn_new_session;
use nix::{
    errno::Errno,
    sys::signal::{SigSet, SigmaskHow, Signal, killpg, pthread_sigmask},
    unistd::Pid,
};
use std::{
    io,
    os::unix::process::ExitStatusExt,
    process::{Child, Command, ExitStatus},
    sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError},
    time::{Duration, Instant},
};

fn signal_set(names: &[Signal]) -> SigSet {
    let mut set = SigSet::empty();
    for signal in names {
        set.add(*signal);
    }
    set
}

#[derive(Default)]
struct Stop {
    pending: Option<Signal>,
    group: Option<Pid>,
}

/// A CLI's signal receiver, started before taking a lease.
pub struct Signals(Mutex<Stop>, Condvar);

impl Signals {
    /// Block and relay the given signals for the life of this CLI process.
    pub fn take(names: &[Signal]) -> io::Result<Arc<Self>> {
        let set = signal_set(names);
        pthread_sigmask(SigmaskHow::SIG_BLOCK, Some(&set), None)?;
        let state = Arc::new(Self(Mutex::default(), Condvar::new()));
        let shared = Arc::clone(&state);
        std::thread::Builder::new().spawn(move || {
            while let Ok(signal) = set.wait() {
                shared.forward(signal);
            }
        })?;
        Ok(state)
    }

    fn forward(&self, signal: Signal) {
        let mut stop = self.lock();
        if let Some(group) = stop.group {
            let _ = killpg(group, signal);
        } else if stop.pending.is_none() {
            stop.pending = Some(signal);
            self.1.notify_all();
        }
    }

    fn lock(&self) -> MutexGuard<'_, Stop> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    #[must_use]
    pub fn pending(&self) -> Option<Signal> {
        self.lock().pending
    }

    pub fn wait_for_stop(&self) {
        let mut stop = self.lock();
        while stop.pending.is_none() {
            stop = self.1.wait(stop).unwrap_or_else(PoisonError::into_inner);
        }
    }

    pub fn spawn(&self, command: &mut Command) -> io::Result<Option<Child>> {
        let mut stop = self.lock();
        if stop.pending.is_some() {
            return Ok(None);
        }
        let child = spawn_new_session(command)?;
        stop.group = Some(Pid::from_raw(
            i32::try_from(child.id()).expect("Linux PID fits in pid_t"),
        ));
        Ok(Some(child))
    }

    pub fn close_group(&self) -> bool {
        self.lock().group.take().is_some_and(kill_session)
    }
}

fn kill_session(group: Pid) -> bool {
    for (signal, grace) in [(Signal::SIGTERM, 10), (Signal::SIGKILL, 5)] {
        if killpg(group, signal) == Err(Errno::ESRCH) {
            return true;
        }
        let deadline = Instant::now() + Duration::from_secs(grace);
        while Instant::now() < deadline {
            if killpg(group, None) == Err(Errno::ESRCH) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    killpg(group, None) == Err(Errno::ESRCH)
}

pub fn end_by(signal: Signal) -> ! {
    let _ = pthread_sigmask(SigmaskHow::SIG_UNBLOCK, Some(&signal_set(&[signal])), None);
    // The signal targets this thread, so the waiting thread cannot take it.
    let _ = nix::sys::signal::raise(signal);
    std::process::exit(128 + signal as i32)
}

/// Store a negative signal number, as in the existing lease records.
#[must_use]
pub fn exit_status(status: ExitStatus) -> i32 {
    status
        .signal()
        .map_or_else(|| status.code().unwrap_or(0), |signal| -signal)
}
