//! At most one retained constructor per fixed child/relay slot. A timeout is
//! not a reap/cleanup acknowledgement, and never admits a replacement process.
use super::{ChildCause, ChildCleanup, ChildError, ChildPhase, RecordDisposition, error::Result};
use crate::{
    engine_metadata::CancellationToken,
    native::{child_signals, ordered_exec::PreparedExec, owned_process as native},
};
use std::{
    os::fd::OwnedFd,
    process::Command,
    sync::{
        Arc, Mutex, OnceLock, TryLockError,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
static RETAINED: OnceLock<[Mutex<Option<Arc<Job>>>; 2]> = OnceLock::new();
#[derive(Default)]
struct Process {
    handshake: Option<native::Handshake>,
    identity: Option<OwnedFd>,
    attempted: bool,
    started: bool,
    status: Option<native::ProcessStatus>,
    kill_sent: bool,
    opaque: bool,
    faults: Vec<ChildCleanup>,
    failed: bool,
}
impl Process {
    fn start(
        &mut self,
        mut command: Command,
        prepared: &Arc<PreparedExec>,
    ) -> std::result::Result<(), ()> {
        self.handshake = Some(native::Handshake::new().map_err(|error| {
            if error.close_failed {
                self.fault(ChildCleanup::HandshakeClose, true);
            }
        })?);
        self.handshake
            .as_ref()
            .expect("prepared channel")
            .configure(&mut command);
        prepared.configure(&mut command);
        self.attempted = true;
        match command.spawn() {
            Err(_) => {
                self.attempted = false;
                self.finish_handshake();
                return Err(());
            }
            Ok(child) => {
                self.started = true;
                drop(child);
            }
        }
        self.acquire()?;
        self.finish_handshake();
        if self.opaque { Err(()) } else { Ok(()) }
    }
    fn acquire(&mut self) -> std::result::Result<(), ()> {
        if self.identity.is_some() {
            return Ok(());
        }
        let result = self.handshake.as_ref().ok_or(())?.receive();
        match result {
            Ok(fd) => {
                self.identity = Some(fd);
                self.started = true;
                Ok(())
            }
            Err(error) => {
                if error.close_failed {
                    self.fault(ChildCleanup::HandshakeClose, true);
                }
                Err(())
            }
        }
    }
    fn finish_handshake(&mut self) {
        if let Some(mut handshake) = self.handshake.take()
            && handshake.finish().is_err()
        {
            self.fault(ChildCleanup::HandshakeClose, true);
        }
    }
    fn reap(&mut self) -> std::result::Result<(), ()> {
        if self.status.is_none()
            && let Some(fd) = &self.identity
        {
            self.status = native::reap_status(fd).map_err(|_| ())?;
        }
        Ok(())
    }
    fn fault(&mut self, fault: ChildCleanup, opaque: bool) {
        if !self.faults.contains(&fault) {
            self.faults.push(fault);
        }
        self.opaque |= opaque;
    }
    fn settled(&self) -> bool {
        !self.attempted || self.status.is_some()
    }
    fn released(&self) -> bool {
        self.settled() && self.handshake.is_none() && self.identity.is_none() && !self.opaque
    }
    fn cleanup(&mut self, deadline: Instant) -> bool {
        if self.attempted
            && self.status.is_none()
            && self.identity.is_none()
            && self.acquire().is_err()
        {
            return false;
        }
        self.finish_handshake();
        let _ = self.reap();
        if self.started && self.status.is_none() && !self.kill_sent {
            self.kill_sent = true;
            if let Some(fd) = &self.identity
                && let Err(error) = native::kill(fd)
                && error.raw_os_error() != Some(libc::ESRCH)
            {
                self.fault(ChildCleanup::Signal, false);
            }
        }
        loop {
            let _ = self.reap();
            if self.settled() {
                self.close_identity();
                return !self.opaque;
            }
            if Instant::now() >= child_signals::clamp(deadline) {
                return false;
            }
            tick(child_signals::clamp(deadline));
        }
    }
    fn close_identity(&mut self) {
        if let Some(fd) = self.identity.take()
            && native::close(fd).is_err()
        {
            self.fault(ChildCleanup::PidfdClose, true);
        }
    }
}
#[derive(Default)]
struct Job {
    state: Mutex<Process>,
    ready: AtomicBool,
    abort: AtomicBool,
    #[cfg(test)]
    hooks: tests::Hooks,
}
/// One exact owned process slot; no PID/argv constructor is public. Only fixed
/// guest relay/pane purposes can provide Command and precomputed exec data.
pub(super) struct OwnedProcess {
    job: Arc<Job>,
}
impl OwnedProcess {
    pub(super) fn begin(command: Command, prepared: Arc<PreparedExec>, deadline: Instant) -> Self {
        Self::launch(command, prepared, deadline, Arc::new(Job::default()))
    }
    fn launch(
        command: Command,
        prepared: Arc<PreparedExec>,
        deadline: Instant,
        job: Arc<Job>,
    ) -> Self {
        let owned = Self { job };
        let job = Arc::clone(&owned.job);
        if std::thread::Builder::new()
            .name("reverie-child-constructor".into())
            .spawn(move || construct(job, command, prepared, deadline))
            .is_err()
        {
            let mut state = owned
                .job
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.failed = true;
            drop(state);
            owned.job.ready.store(true, Ordering::Release);
        }
        owned
    }
    pub(super) fn wait_ready(&self, deadline: Instant, cancel: &CancellationToken) -> Result<()> {
        loop {
            if self.job.ready.load(Ordering::Acquire) {
                return self.ready_result();
            }
            if cancelled(cancel) || Instant::now() >= child_signals::clamp(deadline) {
                let cause = cancellation_cause(cancel);
                self.job.abort.store(true, Ordering::Release);
                return Err(failure(cause).finalizer(ChildCleanup::PendingStart));
            }
            tick(child_signals::clamp(deadline));
        }
    }
    fn ready_result(&self) -> Result<()> {
        let state =
            self.job.state.try_lock().map_err(|_| {
                failure(ChildCause::Finalization).finalizer(ChildCleanup::PendingStart)
            })?;
        if state.failed {
            Err(report(failure(ChildCause::Spawn), &state))
        } else {
            Ok(())
        }
    }
    pub(super) fn cleanup(&self, deadline: Instant) -> Result<()> {
        self.job.abort.store(true, Ordering::Release);
        loop {
            if self.cleanup_step(deadline)? {
                return Ok(());
            }
            tick(child_signals::clamp(deadline));
        }
    }
    fn cleanup_step(&self, deadline: Instant) -> Result<bool> {
        match self.job.state.try_lock() {
            Ok(mut state) => self.cleanup_locked(&mut state, deadline),
            Err(TryLockError::Poisoned(error)) => {
                let mut state = error.into_inner();
                state.opaque = true;
                let _ = state.cleanup(deadline);
                Err(report(failure(ChildCause::Finalization), &state))
            }
            Err(TryLockError::WouldBlock) if Instant::now() >= child_signals::clamp(deadline) => {
                Err(failure(ChildCause::Finalization).finalizer(ChildCleanup::PendingStart))
            }
            Err(TryLockError::WouldBlock) => Ok(false),
        }
    }
    fn cleanup_locked(&self, state: &mut Process, deadline: Instant) -> Result<bool> {
        if self.job.ready.load(Ordering::Acquire) && state.cleanup(deadline) {
            return Ok(true);
        }
        if Instant::now() >= child_signals::clamp(deadline) {
            Err(report(
                failure(ChildCause::Finalization).finalizer(ChildCleanup::Unreaped),
                state,
            ))
        } else {
            Ok(false)
        }
    }
    pub(super) fn status(&self) -> Result<Option<u8>> {
        let mut state = self
            .job
            .state
            .try_lock()
            .map_err(|_| failure(ChildCause::Finalization))?;
        state.reap().map_err(|()| failure(ChildCause::Changed))?;
        Ok(state.status.map(native::ProcessStatus::shell_code))
    }
}
impl Drop for OwnedProcess {
    fn drop(&mut self) {
        self.job.abort.store(true, Ordering::Release);
        if let Ok(state) = self.job.state.try_lock()
            && self.job.ready.load(Ordering::Acquire)
            && state.released()
        {
            return;
        }
        // The standalone runtime admits at most two slots and remains globally
        // fenced if abandoned. Retain exact ownership after a caller mistake;
        // no detached-thread/drop assumption may become a cleanup receipt.
        for slot in RETAINED.get_or_init(|| [Mutex::new(None), Mutex::new(None)]) {
            let mut slot = match slot.try_lock() {
                Ok(slot) => slot,
                Err(TryLockError::Poisoned(error)) => error.into_inner(),
                Err(TryLockError::WouldBlock) => continue,
            };
            if slot.as_ref().is_some_and(|job| Arc::ptr_eq(job, &self.job)) {
                return;
            }
            if slot.is_none() {
                *slot = Some(Arc::clone(&self.job));
                return;
            }
        }
        // This cannot occur for the admitted standalone runtime's two slots.
        // Preserve unknown ownership rather than releasing it on invariant loss.
        std::mem::forget(Arc::clone(&self.job));
    }
}
fn construct(job: Arc<Job>, command: Command, prepared: Arc<PreparedExec>, deadline: Instant) {
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut state = job
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if job.abort.load(Ordering::Acquire) || Instant::now() >= child_signals::clamp(deadline) {
            state.failed = true;
            return;
        }
        #[cfg(test)]
        job.hooks.before_start();
        state.failed = state.start(command, &prepared).is_err();
        if job.abort.load(Ordering::Acquire) {
            state.cleanup(deadline);
        }
    }));
    if outcome.is_err() {
        let mut state = job
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.opaque = true;
        state.failed = true;
        state.cleanup(deadline);
    }
    job.ready.store(true, Ordering::Release);
}
pub(super) fn cancelled(cancel: &CancellationToken) -> bool {
    cancel.is_cancelled() || child_signals::signal().is_some()
}
fn cancellation_cause(cancel: &CancellationToken) -> ChildCause {
    if cancelled(cancel) {
        ChildCause::Cancelled
    } else {
        ChildCause::Deadline
    }
}
fn failure(cause: ChildCause) -> ChildError {
    ChildError::new(ChildPhase::Relay, cause).spent(RecordDisposition::Consumed)
}
fn report(mut error: ChildError, state: &Process) -> ChildError {
    for fault in &state.faults {
        error = error.finalizer(*fault);
    }
    error
}
pub(super) fn tick(deadline: Instant) {
    std::thread::sleep(
        deadline
            .saturating_duration_since(Instant::now())
            .min(Duration::from_millis(5)),
    );
}
#[cfg(test)]
mod tests;
