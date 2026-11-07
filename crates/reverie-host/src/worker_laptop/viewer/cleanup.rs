//! Original viewer guard acquisition and native grace are distinct phases.
//! Only fixed worker callers choose no aggregate ceiling; these times carry
//! no process/resource authority and never replace the runtime's first stop.
use super::*;
use std::{
    sync::{MutexGuard, TryLockError},
    time::Duration,
};
pub(super) const TERM: Duration = Duration::from_secs(5);
pub(super) const KILL: Duration = Duration::from_millis(100);
pub(super) fn acquire<'a, T>(
    runtime: &WorkerRuntime,
    lock: &'a Mutex<T>,
    cleanup: Option<Cleanup>,
    refusal: &'static str,
) -> Result<MutexGuard<'a, T>> {
    match cleanup {
        Some(cleanup) => cleanup.acquire(runtime, lock),
        None => lock.try_lock().map_err(|_| LaptopError::Refused(refusal)),
    }
}
#[derive(Clone, Copy)]
pub(in crate::worker_laptop) struct Cleanup {
    ceiling: Option<Instant>,
    guard: Instant,
}
impl Cleanup {
    pub(in crate::worker_laptop) fn bounded(end: Instant) -> Self {
        Self {
            ceiling: Some(end),
            guard: end,
        }
    }
    pub(in crate::worker_laptop) fn worker(runtime: &WorkerRuntime) -> Self {
        Self {
            ceiling: None,
            guard: runtime
                .stop_deadline()
                .unwrap_or_else(|| Instant::now() + TERM + KILL),
        }
    }
    pub(in crate::worker_laptop) fn ceiling(self) -> Option<Instant> {
        self.ceiling
    }
    pub(in crate::worker_laptop) fn guard(self) -> Instant {
        self.guard
    }
    pub(in crate::worker_laptop) fn acquire<'a, T>(
        self,
        runtime: &WorkerRuntime,
        lock: &'a Mutex<T>,
    ) -> Result<MutexGuard<'a, T>> {
        loop {
            match lock.try_lock() {
                Ok(guard) => return Ok(guard),
                Err(TryLockError::Poisoned(_)) => {
                    return Err(LaptopError::Refused("VIEWER_UNREAPED"));
                }
                Err(TryLockError::WouldBlock) => {
                    #[cfg(test)]
                    super::test_hooks::cleanup_waiting(self.guard);
                }
            }
            let end = runtime
                .stop_deadline()
                .map_or(self.guard, |stop| stop.min(self.guard));
            need(Instant::now() < end, "VIEWER_UNREAPED")?;
            std::thread::sleep(Duration::from_millis(1));
        }
    }
}
pub(super) enum ClosePhase {
    Guard(Instant),
    Term(Instant),
    Kill(Instant),
}
pub(super) struct ClosePlan {
    ceiling: Option<Instant>,
    phase: ClosePhase,
    completion: CloseCompletion,
}
enum CloseCompletion {
    Pending,
    Confirmed,
}
impl ClosePlan {
    pub(super) fn new(ceiling: Option<Instant>, guard: Instant) -> Self {
        Self {
            ceiling,
            phase: ClosePhase::Guard(guard),
            completion: CloseCompletion::Pending,
        }
    }
    pub(super) fn confirm(&mut self) {
        self.completion = CloseCompletion::Confirmed;
    }
    pub(super) fn confirmed(&self) -> bool {
        matches!(self.completion, CloseCompletion::Confirmed)
    }
    pub(super) fn end(&self, supplied: Option<Instant>) -> Instant {
        let phase = match self.phase {
            ClosePhase::Guard(end) | ClosePhase::Term(end) | ClosePhase::Kill(end) => end,
        };
        [self.ceiling, supplied]
            .into_iter()
            .flatten()
            .fold(phase, Instant::min)
    }
    pub(super) fn bound(&self, supplied: Option<Instant>) -> Option<Instant> {
        let phase = match self.phase {
            ClosePhase::Guard(end) | ClosePhase::Kill(end) => Some(end),
            ClosePhase::Term(_) => None,
        };
        [self.ceiling, supplied, phase]
            .into_iter()
            .flatten()
            .reduce(Instant::min)
    }
    pub(super) fn native(&mut self) {
        if matches!(self.phase, ClosePhase::Guard(_)) {
            let term = Instant::now() + TERM;
            self.phase = ClosePhase::Term(term);
        }
    }
    pub(super) fn term_expired(&self) -> bool {
        matches!(self.phase,ClosePhase::Term(term) if Instant::now()>=term)
    }
    pub(super) fn kill(&mut self, end: Option<Instant>) {
        let fresh = Instant::now() + KILL;
        self.phase = ClosePhase::Kill(end.map_or(fresh, |end| end.min(fresh)));
    }
    #[cfg(test)]
    pub(super) fn kill_end(&self) -> Instant {
        let ClosePhase::Kill(end) = self.phase else {
            panic!("actual KILL phase")
        };
        end
    }
}
