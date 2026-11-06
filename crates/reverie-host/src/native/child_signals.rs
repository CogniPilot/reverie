//! Standalone guest-child signals. Handlers only publish fixed atomics and a
//! monotonic first-stop deadline; they never allocate, lock, log or signal PIDs.
#![allow(unsafe_code)]
use std::{
    io, mem,
    sync::{
        OnceLock,
        atomic::{AtomicBool, AtomicI32, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
static ACTIVE: AtomicBool = AtomicBool::new(false);
static SIGNAL: AtomicI32 = AtomicI32::new(0);
static DEADLINE: AtomicU64 = AtomicU64::new(u64::MAX);
static ANCHOR: OnceLock<(Instant, u64)> = OnceLock::new();
const STOP_NANOS: u64 = 34_000_000_000;
#[cfg(test)]
static FAIL_RESTORE: AtomicBool = AtomicBool::new(false);
fn clock() -> Option<u64> {
    // SAFETY: timespec is valid writable ABI storage. clock_gettime is
    // async-signal-safe; CLOCK_MONOTONIC is the same Linux Instant clock.
    let mut time: libc::timespec = unsafe { mem::zeroed() };
    if unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut time) } != 0 {
        return None;
    }
    u64::try_from(time.tv_sec)
        .ok()?
        .checked_mul(1_000_000_000)?
        .checked_add(u64::try_from(time.tv_nsec).ok()?)
}
extern "C" fn stopped(signal: i32) {
    // SAFETY: errno is this interrupted thread's TLS integer. Preserve it
    // across the async-signal-safe clock call before returning to that thread.
    let saved = unsafe { *libc::__errno_location() };
    DEADLINE.fetch_min(
        clock()
            .and_then(|now| now.checked_add(STOP_NANOS))
            .unwrap_or(0),
        Ordering::AcqRel,
    );
    let _ = SIGNAL.compare_exchange(0, signal, Ordering::AcqRel, Ordering::Acquire);
    unsafe {
        *libc::__errno_location() = saved;
    }
}
pub(crate) fn signal() -> Option<i32> {
    match SIGNAL.load(Ordering::Acquire) {
        0 => None,
        signal => Some(signal),
    }
}
pub(crate) fn clamp(deadline: Instant) -> Instant {
    let stop = DEADLINE.load(Ordering::Acquire);
    if stop == u64::MAX {
        return deadline;
    }
    let Some(&(instant, clock)) = ANCHOR.get() else {
        return Instant::now().min(deadline);
    };
    instant
        .checked_add(Duration::from_nanos(stop.saturating_sub(clock)))
        .unwrap_or(instant)
        .min(deadline)
}
pub(crate) struct SignalGuard {
    previous: [libc::sigaction; 2],
    armed: bool,
}
pub(crate) struct SignalError {
    pub(crate) cause: io::Error,
    pub(crate) restoration_failed: bool,
}
impl From<io::Error> for SignalError {
    fn from(cause: io::Error) -> Self {
        Self {
            cause,
            restoration_failed: false,
        }
    }
}
impl From<io::ErrorKind> for SignalError {
    fn from(cause: io::ErrorKind) -> Self {
        io::Error::from(cause).into()
    }
}
impl SignalGuard {
    pub(crate) fn install() -> Result<Self, SignalError> {
        if ACTIVE
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(io::ErrorKind::AlreadyExists.into());
        }
        let instant = Instant::now();
        let Some(now) = clock() else {
            ACTIVE.store(false, Ordering::Release);
            return Err(io::Error::last_os_error().into());
        };
        ANCHOR.get_or_init(|| (instant, now));
        SIGNAL.store(0, Ordering::Release);
        DEADLINE.store(u64::MAX, Ordering::Release);
        // SAFETY: zero-initialized sigaction is valid; initialized empty mask
        // and one C handler install only for this standalone child process.
        let mut action: libc::sigaction = unsafe { mem::zeroed() };
        unsafe {
            libc::sigemptyset(&mut action.sa_mask);
        }
        action.sa_sigaction = stopped as *const () as usize;
        let mut previous: [libc::sigaction; 2] = unsafe { mem::zeroed() };
        for (index, signal) in [libc::SIGINT, libc::SIGTERM].into_iter().enumerate() {
            if unsafe { libc::sigaction(signal, &action, &mut previous[index]) } != 0 {
                return Err(installation_error(index, &previous));
            }
        }
        Ok(Self {
            previous,
            armed: true,
        })
    }
    pub(crate) fn finish(mut self) -> io::Result<()> {
        let result = self.restore();
        self.armed = false;
        result
    }
    fn restore(&self) -> io::Result<()> {
        let mut failed = false;
        for (index, signal) in [libc::SIGINT, libc::SIGTERM].into_iter().enumerate() {
            // SAFETY: restore initialized prior actions; no Rust callback or
            // borrowed pointer remains in the process handler afterwards.
            failed |=
                unsafe { libc::sigaction(signal, &self.previous[index], std::ptr::null_mut()) }
                    != 0;
        }
        #[cfg(test)]
        {
            failed |= FAIL_RESTORE.swap(false, Ordering::AcqRel);
        }
        if failed {
            Err(io::ErrorKind::Other.into())
        } else {
            ACTIVE.store(false, Ordering::Release);
            Ok(())
        }
    }
}
#[cfg(test)]
pub(crate) fn fail_restore_once() {
    FAIL_RESTORE.store(true, Ordering::Release);
}
#[cfg(test)]
pub(crate) fn exercise_first_stop_and_errno() {
    // SAFETY: called only in the separately owned installed guest test process.
    // Test the same C handler's errno preservation and one real installed signal.
    unsafe {
        *libc::__errno_location() = libc::EBUSY;
    }
    stopped(libc::SIGTERM);
    assert_eq!(unsafe { *libc::__errno_location() }, libc::EBUSY);
    let future = Instant::now() + Duration::from_secs(60);
    let first = clamp(future);
    assert!(first <= Instant::now() + Duration::from_secs(34));
    assert_eq!(unsafe { libc::raise(libc::SIGINT) }, 0);
    assert_eq!(signal(), Some(libc::SIGTERM));
    assert_eq!(clamp(future), first);
}
fn installation_error(index: usize, previous: &[libc::sigaction; 2]) -> SignalError {
    let cause = io::Error::last_os_error();
    // SAFETY: index1 means SIGINT was installed and its prior initialized
    // action must be restored. No other action was changed on index0 failure.
    let restoration_failed = index == 1
        && unsafe { libc::sigaction(libc::SIGINT, &previous[0], std::ptr::null_mut()) } != 0;
    if !restoration_failed {
        ACTIVE.store(false, Ordering::Release);
    }
    SignalError {
        cause,
        restoration_failed,
    }
}
impl Drop for SignalGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = self.restore();
        }
    }
}
pub(crate) fn private_umask() {
    // SAFETY: standalone CLI initializes the process mask before any threads.
    unsafe {
        libc::umask(0o077);
    }
}
