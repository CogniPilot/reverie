use super::{
    CleanupFault, EngineBootstrap, EngineError, EngineFault, EngineQuery, MAX_QUERY_SECONDS,
    Result, process::Process,
};
use std::{
    ffi::OsString,
    sync::{
        Arc, Mutex, TryLockError,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

#[derive(Clone, Default)]
pub struct CancellationToken(Arc<AtomicBool>);
impl CancellationToken {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}
#[derive(Default)]
struct JobData {
    process: Process,
    result: Option<Result<String>>,
}
pub(super) struct Job {
    external: CancellationToken,
    abort: AtomicBool,
    finished: AtomicBool,
    data: Mutex<JobData>,
    #[cfg(test)]
    pub(super) hooks: super::tests::Hooks,
}
impl Job {
    pub(super) fn cancelled(&self) -> bool {
        self.abort.load(Ordering::Acquire) || self.external.is_cancelled()
    }
}
/// One persistent installing-service context, intentionally not Clone. Keep it
/// alive across observation failures and check settle_owned before acknowledging
/// shutdown. One active/pending client fences every subsequent query; no retry,
/// replacement context or forgotten thread is a cleanup receipt.
#[must_use = "retain the engine context and check settle_owned before shutdown acknowledgement"]
pub struct ReadonlyEngine {
    bootstrap: Arc<EngineBootstrap>,
    active: Mutex<Option<Arc<Job>>>,
}
impl ReadonlyEngine {
    pub fn new(bootstrap: EngineBootstrap) -> Self {
        Self {
            bootstrap: Arc::new(bootstrap),
            active: Mutex::new(None),
        }
    }
    /// Caller supplies the observer's one overall deadline (at most thirty
    /// seconds); each fixed metadata command is additionally clamped to twenty.
    pub fn query(
        &self,
        query: EngineQuery<'_>,
        deadline: Instant,
        cancellation: &CancellationToken,
    ) -> Result<String> {
        let args = query.arguments()?;
        let deadline = deadline.min(Instant::now() + Duration::from_secs(MAX_QUERY_SECONDS));
        if cancellation.is_cancelled() {
            return Err(EngineError::new(EngineFault::Cancelled));
        }
        if Instant::now() >= deadline {
            return Err(EngineError::new(EngineFault::Deadline));
        }
        let job = self.admit(cancellation)?;
        let bootstrap = Arc::clone(&self.bootstrap);
        let owned = Arc::clone(&job);
        if std::thread::Builder::new()
            .name("reverie-engine-metadata".into())
            .spawn(move || execute(bootstrap, args, deadline, owned))
            .is_err()
        {
            let mut data = job
                .data
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            data.result = Some(Err(EngineError::new(EngineFault::Supervisor)));
            drop(data);
            job.finished.store(true, Ordering::Release);
            self.release(&job)?;
            return Err(EngineError::new(EngineFault::Supervisor));
        }
        loop {
            if job.finished.load(Ordering::Acquire) {
                return self.result(&job, deadline);
            }
            if job.cancelled() || Instant::now() >= deadline {
                let fault = cancellation_fault(job.cancelled());
                job.abort.store(true, Ordering::Release);
                return Err(EngineError::pending(fault, CleanupFault::PendingStart));
            }
            tick(deadline);
        }
    }
    fn admit(&self, external: &CancellationToken) -> Result<Arc<Job>> {
        let mut active = self
            .active
            .try_lock()
            .map_err(|_| EngineError::pending(EngineFault::Busy, CleanupFault::Supervisor))?;
        if active.is_some() {
            return Err(EngineError::pending(
                EngineFault::Busy,
                CleanupFault::Unreaped,
            ));
        }
        let job = Arc::new(Job {
            external: external.clone(),
            abort: AtomicBool::new(false),
            finished: AtomicBool::new(false),
            data: Mutex::new(JobData::default()),
            #[cfg(test)]
            hooks: self.bootstrap.hooks.clone(),
        });
        *active = Some(Arc::clone(&job));
        Ok(job)
    }
    fn release(&self, job: &Arc<Job>) -> Result<()> {
        let mut active = self
            .active
            .try_lock()
            .map_err(|_| EngineError::pending(EngineFault::Supervisor, CleanupFault::Supervisor))?;
        if active
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, job))
        {
            *active = None;
        }
        Ok(())
    }
    fn result(&self, job: &Arc<Job>, deadline: Instant) -> Result<String> {
        let mut data = job
            .data
            .try_lock()
            .map_err(|_| EngineError::pending(EngineFault::Supervisor, CleanupFault::Supervisor))?;
        let result = data.result.take().ok_or_else(|| {
            EngineError::pending(EngineFault::Supervisor, CleanupFault::Supervisor)
        })?;
        let retained = result.as_ref().err().is_some_and(EngineError::is_uncertain);
        if !retained {
            self.release(job)?;
        }
        if job.cancelled() || Instant::now() >= deadline {
            let fault = cancellation_fault(job.cancelled());
            return Err(data.process.report(EngineError::new(fault)));
        }
        result
    }
    /// Settle only retained exact clients/pipe writers under a supplied shutdown
    /// budget. It never repeats an engine query or changes its failed outcome.
    pub fn settle_owned(&self, deadline: Instant) -> Result<()> {
        let job = self
            .active
            .try_lock()
            .map_err(|_| EngineError::pending(EngineFault::Supervisor, CleanupFault::Supervisor))?
            .clone();
        let Some(job) = job else {
            return Ok(());
        };
        job.abort.store(true, Ordering::Release);
        loop {
            if job.finished.load(Ordering::Acquire) {
                return self.settle_finished(&job, deadline);
            }
            if Instant::now() >= deadline {
                return Err(EngineError::pending(
                    EngineFault::Deadline,
                    CleanupFault::PendingStart,
                ));
            }
            tick(deadline);
        }
    }
    fn settle_finished(&self, job: &Arc<Job>, deadline: Instant) -> Result<()> {
        let mut data = match job.data.try_lock() {
            Ok(data) => data,
            Err(TryLockError::Poisoned(error)) => error.into_inner(),
            Err(TryLockError::WouldBlock) => {
                return Err(EngineError::pending(
                    EngineFault::Supervisor,
                    CleanupFault::Supervisor,
                ));
            }
        };
        if !data.process.cleanup(deadline, job) {
            return Err(data
                .process
                .report(EngineError::new(EngineFault::Finalization)));
        }
        drop(data);
        self.release(job)
    }
}
impl Drop for ReadonlyEngine {
    fn drop(&mut self) {
        if let Ok(Some(job)) = self.active.get_mut() {
            job.abort.store(true, Ordering::Release);
        }
    }
}
fn cancellation_fault(cancelled: bool) -> EngineFault {
    if cancelled {
        EngineFault::Cancelled
    } else {
        EngineFault::Deadline
    }
}
fn execute(bootstrap: Arc<EngineBootstrap>, args: Vec<OsString>, deadline: Instant, job: Arc<Job>) {
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut data = job
            .data
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let value = if job.cancelled() {
            Err(EngineError::new(EngineFault::Cancelled))
        } else if Instant::now() >= deadline {
            Err(EngineError::new(EngineFault::Deadline))
        } else {
            data.process
                .start(&bootstrap, &args)
                .and_then(|()| data.process.observe(deadline, &job))
        };
        data.result = Some(data.process.finish(value, deadline, &job));
    }));
    if outcome.is_err() {
        let mut data = job
            .data
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        data.process.mark_unknown();
        data.process.cleanup(deadline, &job);
        let mut error = data
            .process
            .report(EngineError::new(EngineFault::Supervisor));
        error.uncertain = true;
        error.cleanup.push(CleanupFault::Supervisor);
        data.result = Some(Err(error));
    }
    job.finished.store(true, Ordering::Release);
}
fn tick(deadline: Instant) {
    std::thread::sleep(
        deadline
            .saturating_duration_since(Instant::now())
            .min(Duration::from_millis(5)),
    );
}
