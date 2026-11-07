//! Concrete same-record handler thread custody, not a callback executor. The
//! App creates only its fixed handler; this owner adopts its real JoinHandle
//! before the child can authenticate/read a frame. No caller-created thread ID
//! or error value proves that a handler did not start.
use super::*;
use std::{
    io,
    thread::{JoinHandle, ThreadId},
};

pub(super) struct HandlerJob {
    parent: ThreadId,
    engine: Arc<InstalledWorkerEngine>,
    thread: OnceLock<Mutex<Option<JoinHandle<()>>>>,
    entered: OnceLock<ThreadId>,
    abandoned: AtomicBool,
    unread_dropped_by_parent: AtomicBool,
    joined: AtomicBool,
    published: AtomicBool,
    opaque: AtomicBool,
}
#[must_use = "publish the actual thread handle or retain failed construction"]
pub struct WorkerHandlerConstruction {
    service: Arc<WorkerReportService>,
    record: Arc<Record>,
    job: Arc<HandlerJob>,
    decided: bool,
}
impl HandlerJob {
    #[cfg(test)]
    pub(super) fn test_entered(&self) -> bool {
        self.entered.get().is_some()
    }
    fn new(service: &WorkerReportService) -> Self {
        Self {
            parent: std::thread::current().id(),
            engine: service.engine.clone(),
            thread: OnceLock::new(),
            entered: OnceLock::new(),
            abandoned: AtomicBool::new(false),
            unread_dropped_by_parent: AtomicBool::new(false),
            joined: AtomicBool::new(false),
            published: AtomicBool::new(false),
            opaque: AtomicBool::new(false),
        }
    }
    fn bound(&self, end: Instant) -> Instant {
        self.engine
            .stop_deadline()
            .map_or(end, |stop| stop.min(end))
    }
    pub(super) fn known_settled(&self) -> bool {
        !self.opaque.load(Ordering::Acquire)
            && (self.joined.load(Ordering::Acquire)
                || (self.thread.get().is_none()
                    && self.abandoned.load(Ordering::Acquire)
                    && self.unread_dropped_by_parent.load(Ordering::Acquire)))
    }
    /// This observation comes only from Drop of the actual unread socket token,
    /// on its recorded constructing thread. An io::Error alone cannot mint it.
    pub(super) fn unread_dropped(&self) {
        if self.entered.get().is_none() && std::thread::current().id() == self.parent {
            self.unread_dropped_by_parent.store(true, Ordering::Release);
        }
    }
    pub(super) fn enter(&self, service: &WorkerReportService) -> Result<()> {
        let current = std::thread::current().id();
        if self.entered.set(current).is_err() && self.entered.get() != Some(&current) {
            self.opaque.store(true, Ordering::Release);
            return Err(WorkerReportError::Unconfirmed);
        }
        loop {
            if self.opaque.load(Ordering::Acquire) {
                return Err(WorkerReportError::Unconfirmed);
            }
            if service.stopping() || self.abandoned.load(Ordering::Acquire) {
                return Err(WorkerReportError::Stopping);
            }
            let thread = self
                .published
                .load(Ordering::Acquire)
                .then(|| self.thread.get())
                .flatten();
            let Some(thread) = thread else {
                std::thread::sleep(Duration::from_millis(1));
                continue;
            };
            if self.enter_published(thread, current)? {
                return Ok(());
            }
        }
    }
    fn enter_published(
        &self,
        thread: &Mutex<Option<JoinHandle<()>>>,
        current: ThreadId,
    ) -> Result<bool> {
        let thread = match thread.try_lock() {
            Ok(thread) => thread,
            Err(TryLockError::WouldBlock) => {
                std::thread::yield_now();
                return Ok(false);
            }
            Err(TryLockError::Poisoned(_)) => {
                self.opaque.store(true, Ordering::Release);
                return Err(WorkerReportError::Unconfirmed);
            }
        };
        if thread
            .as_ref()
            .is_some_and(|thread| thread.thread().id() == current)
        {
            return Ok(true);
        }
        self.opaque.store(true, Ordering::Release);
        Err(WorkerReportError::Unconfirmed)
    }
    /// Join only the actual published handle. `is_finished` prevents a planned
    /// blocking wait; fixed Rust-thread/kernel latency is not a hard bound.
    pub(super) fn settle(&self, deadline: Instant) -> Result<()> {
        loop {
            if self.join_once()? {
                return Ok(());
            }
            let end = self.bound(deadline);
            if Instant::now() >= end {
                return Err(WorkerReportError::Unconfirmed);
            }
            std::thread::sleep(
                end.saturating_duration_since(Instant::now())
                    .min(Duration::from_millis(1)),
            );
        }
    }
    pub(super) fn join_once(&self) -> Result<bool> {
        if self.known_settled() {
            return Ok(true);
        }
        let Some(thread) = self.thread.get() else {
            return Ok(false);
        };
        let mut slot = match thread.try_lock() {
            Ok(slot) => slot,
            Err(TryLockError::WouldBlock) => return Ok(false),
            Err(TryLockError::Poisoned(error)) => {
                self.opaque.store(true, Ordering::Release);
                error.into_inner()
            }
        };
        let Some(thread) = slot.as_ref() else {
            return Err(WorkerReportError::Unconfirmed);
        };
        if thread.thread().id() == std::thread::current().id() {
            return Err(WorkerReportError::Unconfirmed);
        }
        if !thread.is_finished() {
            return Ok(false);
        }
        let thread = slot.take().expect("checked same actual handle");
        let matched = self
            .entered
            .get()
            .is_some_and(|entered| *entered == thread.thread().id());
        if thread.join().is_err() || !matched {
            self.opaque.store(true, Ordering::Release);
        }
        self.joined.store(true, Ordering::Release);
        if self.known_settled() {
            Ok(true)
        } else {
            Err(WorkerReportError::Unconfirmed)
        }
    }
}
impl WorkerHandlerConstruction {
    pub(super) fn new(service: Arc<WorkerReportService>, record: Arc<Record>) -> Result<Self> {
        if service.stopping() || !record.can_progress() {
            return Err(WorkerReportError::Stopping);
        }
        let mut owner = record
            .handler
            .try_lock()
            .map_err(|_| WorkerReportError::Unconfirmed)?;
        if owner.is_some() {
            return Err(WorkerReportError::Unconfirmed);
        }
        let job = Arc::new(HandlerJob::new(&service));
        *owner = Some(job.clone());
        drop(owner);
        Ok(Self {
            service,
            record,
            job,
            decided: false,
        })
    }
    /// Adoption occurs before any fallible identity check. The nonclone token
    /// has exactly one publication, and the child verifies this exact ID.
    pub fn publish(mut self, thread: JoinHandle<()>) -> Result<()> {
        self.job
            .thread
            .set(Mutex::new(Some(thread)))
            .expect("one constructor publication");
        self.decided = true;
        if std::thread::current().id() != self.job.parent {
            self.job.opaque.store(true, Ordering::Release);
            self.record.mark_opaque();
            return Err(WorkerReportError::Unconfirmed);
        }
        self.job.published.store(true, Ordering::Release);
        Ok(())
    }
    /// Failed std::thread creation drops the closure's original unread token
    /// back on this SAME constructing thread. Require that actual observation;
    /// a supplied error cannot clear a live or missing thread owner.
    pub fn spawn_failed(mut self, cause: io::Error) -> Result<()> {
        self.job.abandoned.store(true, Ordering::Release);
        self.decided = true;
        if std::thread::current().id() != self.job.parent || !self.job.known_settled() {
            self.record.mark_opaque();
            return finalized(Err(cause.into()), Err(WorkerReportError::Unconfirmed));
        }
        finalized(
            Err(cause.into()),
            self.service.finish_registered_for_worker(&self.record),
        )
    }
}
impl Drop for WorkerHandlerConstruction {
    fn drop(&mut self) {
        if !self.decided {
            self.job.abandoned.store(true, Ordering::Release);
        }
    }
}
