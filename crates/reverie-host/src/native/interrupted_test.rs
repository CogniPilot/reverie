//! Test-only fixed SIGUSR1 interruption, exclusively in an exact owning process.
//! No PID/thread target escapes. The calling thread stays synchronously on this
//! stack until its internally scoped sender is joined, including on unwinding.
use std::{
    io, mem, ptr,
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    time::Duration,
};
static ACTIVE: AtomicBool = AtomicBool::new(false);
static SIGNALS: AtomicUsize = AtomicUsize::new(0);
extern "C" fn interrupted(_: libc::c_int) {
    // Native lock-free usize atomics only; no allocation, errno call, Rust
    // callback or borrowed pointer is accessed by this fixed signal handler.
    SIGNALS.fetch_add(1, Ordering::Relaxed);
}
struct Guard {
    action: Option<libc::sigaction>,
    mask: Option<libc::sigset_t>,
    set: libc::sigset_t,
    released: bool,
}
#[derive(Debug)]
struct Finalization {
    primary: io::Error,
    restoration: io::Error,
}
impl std::fmt::Display for Finalization {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}; signal restoration: {}",
            self.primary, self.restoration
        )
    }
}
impl std::error::Error for Finalization {}
fn finalized<T>(result: io::Result<T>, restored: io::Result<()>) -> io::Result<T> {
    match (result, restored) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(primary), Err(restoration)) => Err(io::Error::other(Finalization {
            primary,
            restoration,
        })),
    }
}
fn status(value: libc::c_int) -> io::Result<()> {
    if value == 0 {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(value))
    }
}
impl Guard {
    fn install() -> io::Result<Self> {
        let case = std::env::var("REVERIE_HOST_OWNING_TEST_CASE")
            .map_err(|_| io::ErrorKind::PermissionDenied)?;
        if std::thread::current().name() != Some(case.as_str()) {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        if ACTIVE
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(io::ErrorKind::AlreadyExists.into());
        }
        // SAFETY: these are initialized writable C ABI records. Only SIGUSR1
        // is changed in this one separately owned test process/current thread.
        let mut guard = Self {
            action: None,
            mask: None,
            set: unsafe { mem::zeroed() },
            released: false,
        };
        if let Err(error) = guard.configure() {
            return finalized(Err(error), guard.restore());
        }
        Ok(guard)
    }
    fn configure(&mut self) -> io::Result<()> {
        // SAFETY: self owns writable initialized ABI storage and SIGUSR1 is a
        // valid fixed signal. No caller pointer or dynamic signal is accepted.
        unsafe {
            libc::sigemptyset(&mut self.set);
            libc::sigaddset(&mut self.set, libc::SIGUSR1);
        }
        let mut old_mask = unsafe { mem::zeroed() };
        status(unsafe { libc::pthread_sigmask(libc::SIG_BLOCK, &self.set, &mut old_mask) })?;
        self.mask = Some(old_mask);
        // Reserve only a dedicated, initially nonpending signal. If setup
        // refuses here, restore the original mask WITHOUT consuming it.
        let mut pending = unsafe { mem::zeroed() };
        if unsafe { libc::sigpending(&mut pending) } != 0 {
            return Err(io::Error::last_os_error());
        }
        if unsafe { libc::sigismember(&pending, libc::SIGUSR1) } != 0 {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "owned SIGUSR1 already pending",
            ));
        }
        let mut action: libc::sigaction = unsafe { mem::zeroed() };
        unsafe {
            libc::sigemptyset(&mut action.sa_mask);
        }
        action.sa_sigaction = interrupted as *const () as usize;
        // No SA_RESTART: actual blocked native reads must surface EINTR.
        let mut old_action = unsafe { mem::zeroed() };
        if unsafe { libc::sigaction(libc::SIGUSR1, &action, &mut old_action) } != 0 {
            return Err(io::Error::last_os_error());
        }
        self.action = Some(old_action);
        SIGNALS.store(0, Ordering::Release);
        status(unsafe { libc::pthread_sigmask(libc::SIG_UNBLOCK, &self.set, ptr::null_mut()) })?;
        Ok(())
    }
    fn restore(&mut self) -> io::Result<()> {
        if self.released {
            return Ok(());
        }
        if self.mask.is_none() {
            ACTIVE.store(false, Ordering::Release);
            self.released = true;
            return Ok(());
        }
        // SAFETY: caller has already joined the only sender. Block and drain
        // remaining owned SIGUSR1 before restoring the prior action/mask; no
        // signal can later reach a restored default disposition unexpectedly.
        status(unsafe { libc::pthread_sigmask(libc::SIG_BLOCK, &self.set, ptr::null_mut()) })?;
        if self.action.is_some() {
            self.drain()?;
        }
        if let Some(action) = &self.action
            && unsafe { libc::sigaction(libc::SIGUSR1, action, ptr::null_mut()) } != 0
        {
            return Err(io::Error::last_os_error());
        }
        if let Some(mask) = &self.mask {
            status(unsafe { libc::pthread_sigmask(libc::SIG_SETMASK, mask, ptr::null_mut()) })?;
        }
        self.action = None;
        self.mask = None;
        ACTIVE.store(false, Ordering::Release);
        self.released = true;
        Ok(())
    }
    fn drain(&self) -> io::Result<()> {
        // SAFETY: only this installed fixture action's pending fixed signal is
        // drained, after the scoped sender joined. No other SIGUSR1 producer
        // belongs in this separately owned test process.
        let zero = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        loop {
            let result = unsafe { libc::sigtimedwait(&self.set, ptr::null_mut(), &zero) };
            if result == libc::SIGUSR1 {
                continue;
            }
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::EAGAIN) {
                break;
            }
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
        Ok(())
    }
}
impl Drop for Guard {
    fn drop(&mut self) {
        let _ = self.restore();
    }
}
/// Fixed, bounded interruption of only this synchronous calling pthread. This
/// helper is cfg(test), not a production callback, command/target or grant API.
pub(crate) fn interrupt_current<T>(operation: impl FnOnce() -> T) -> io::Result<(T, usize)> {
    let mut guard = Guard::install()?;
    let complete = AtomicBool::new(false);
    // SAFETY: pthread_self captures this still-running caller. The raw value
    // stays inside thread::scope, whose join precedes caller return/unwinding;
    // it can never refer to a reaped/reused or caller-selected thread.
    let target = unsafe { libc::pthread_self() };
    let send = || {
        for _ in 0..130 {
            std::thread::sleep(Duration::from_millis(100));
            if complete.load(Ordering::Acquire) {
                break;
            }
            // SAFETY: target is the live scoped caller above, which cannot
            // leave this scope until this sender joins. No group is used.
            status(unsafe { libc::pthread_kill(target, libc::SIGUSR1) })?;
        }
        Ok(())
    };
    let (output, sender) = std::thread::scope(|scope| {
        let owned = scope.spawn(send);
        let output = operation();
        complete.store(true, Ordering::Release);
        let sender = owned
            .join()
            .map_err(|_| io::Error::other("owned signal sender failed"))
            .and_then(|value| value);
        (output, sender)
    });
    let count = SIGNALS.load(Ordering::Acquire);
    let restored = guard.restore();
    finalized(sender, restored)?;
    Ok((output, count))
}
#[test]
fn released_guard_drop_cannot_clear_a_later_owned_signal_installation() {
    let (_, module) = module_path!().split_once("::").unwrap();
    if crate::test_process::isolate_case(&format!(
        "{module}::released_guard_drop_cannot_clear_a_later_owned_signal_installation"
    )) {
        return;
    }
    let mut first = Guard::install().unwrap();
    first.restore().unwrap();
    let mut second = Guard::install().unwrap();
    drop(first);
    assert!(ACTIVE.load(Ordering::Acquire));
    assert!(matches!(Guard::install(), Err(error) if error.kind()==io::ErrorKind::AlreadyExists));
    second.restore().unwrap();
}
#[test]
fn initially_pending_dedicated_signal_is_refused_without_consumption_or_action_change() {
    let (_, module) = module_path!().split_once("::").unwrap();
    if crate::test_process::isolate_case(&format!(
        "{module}::initially_pending_dedicated_signal_is_refused_without_consumption_or_action_change"
    )) {
        return;
    }
    // SAFETY: exclusively this live calling pthread is blocked and queued with
    // the fixed signal in its exact owning test process. No raw target escapes.
    let mut set: libc::sigset_t = unsafe { mem::zeroed() };
    unsafe {
        libc::sigemptyset(&mut set);
        libc::sigaddset(&mut set, libc::SIGUSR1);
    }
    let mut previous = unsafe { mem::zeroed() };
    status(unsafe { libc::pthread_sigmask(libc::SIG_BLOCK, &set, &mut previous) }).unwrap();
    let target = unsafe { libc::pthread_self() };
    status(unsafe { libc::pthread_kill(target, libc::SIGUSR1) }).unwrap();
    assert!(matches!(Guard::install(),Err(error) if error.kind()==io::ErrorKind::AlreadyExists));
    let mut pending = unsafe { mem::zeroed() };
    assert_eq!(unsafe { libc::sigpending(&mut pending) }, 0);
    assert_eq!(unsafe { libc::sigismember(&pending, libc::SIGUSR1) }, 1);
    let zero = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    assert_eq!(
        unsafe { libc::sigtimedwait(&set, ptr::null_mut(), &zero) },
        libc::SIGUSR1
    );
    status(unsafe { libc::pthread_sigmask(libc::SIG_SETMASK, &previous, ptr::null_mut()) })
        .unwrap();
    assert!(!ACTIVE.load(Ordering::Acquire));
}
