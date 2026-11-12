use super::{
    CapturedOutput, CleanupFault, Error as EngineError, Fault as EngineFault, InstalledCommand,
    Policy, Result, process::Process,
};
use std::{
    ffi::OsString,
    sync::{
        Arc, Mutex, OnceLock, TryLockError,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
#[cfg(test)]
mod tests;

#[derive(Clone, Default)]
pub struct CancellationToken(Arc<CancellationState>);
#[derive(Default)]
struct CancellationState {
    cancelled: AtomicBool,
    signals: OnceLock<Arc<crate::native::child_signals::SignalView>>,
}
impl CancellationToken {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn cancel(&self) {
        self.0.cancelled.store(true, Ordering::Release);
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.cancelled.load(Ordering::Acquire) || self.worker_signal_deadline().is_some()
    }
    pub(crate) fn bind_worker_signals(
        &self,
        view: Arc<crate::native::child_signals::SignalView>,
    ) -> bool {
        self.0.signals.set(view).is_ok()
    }
    pub(crate) fn worker_signal_deadline(&self) -> Option<Instant> {
        self.0.signals.get().and_then(|view| view.deadline())
    }
}
#[derive(Default)]
struct JobData {
    process: Process,
    result: Option<Result<CapturedOutput>>,
}
pub(super) struct Job {
    external: CancellationToken,
    abort: AtomicBool,
    finished: AtomicBool,
    data: Mutex<JobData>,
    pub(super) policy: Policy,
    pub(super) nix_tail: bool,
    pub(super) stdout_only: bool,
    pub(super) raw_stdout: bool,
    #[cfg(test)]
    pub(super) hooks: super::test_hooks::Hooks,
}
impl Job {
    pub(super) fn cancelled(&self) -> bool {
        self.abort.load(Ordering::Acquire)
            || self.external.is_cancelled()
            || (self.nix_tail && crate::native::child_signals::signal().is_some())
    }
    fn has_pending_native_work(&self) -> bool {
        if !self.finished.load(Ordering::Acquire) {
            return true;
        }
        let Ok(data) = self.data.try_lock() else {
            return true;
        };
        data.process.has_pending_native_work()
    }
}
/// One persistent installing-service context, intentionally not Clone. Keep it
/// alive across observation failures and check settle_owned before acknowledging
/// shutdown. One active/pending client fences every subsequent query; no retry,
/// replacement context or forgotten thread is a cleanup receipt.
#[must_use = "retain the engine context and check settle_owned before shutdown acknowledgement"]
pub(crate) struct CapturedClient {
    bootstrap: Arc<InstalledCommand>,
    active: Mutex<Option<Active>>,
    closing: AtomicBool,
}
#[derive(Clone)]
enum Active {
    Query(Arc<Job>),
    ViewerConstructor(Arc<crate::worker_laptop::ViewerJob>),
}
impl Active {
    #[cfg(test)]
    fn query(&self) -> &Arc<Job> {
        let Self::Query(job) = self else {
            panic!("actual query fixture expected")
        };
        job
    }
}
/// Exact native job custody, minted only after actual locked admission. It is
/// not an engine effect/owner permit and has no wire or PID/path constructor.
pub(crate) struct CapturedCall {
    origin: Arc<InstalledCommand>,
    job: Arc<Job>,
}
impl CapturedCall {
    /// Observe only this actual admitted job. Consumed-close uncertainty may
    /// have no native handle left; false is never cleanup/release success.
    pub(crate) fn has_pending_native_work(&self) -> bool {
        self.job.has_pending_native_work()
    }
}
pub(crate) struct CallFailure {
    pub(crate) error: EngineError,
    pub(crate) call: Option<CapturedCall>,
}
#[derive(Clone, Copy)]
enum ExecutionMode {
    Combined,
    CombinedWaiting,
    NixTail,
    GoalStdout,
    GpuPreflightStdout,
}
impl CallFailure {
    fn before_admission(error: EngineError) -> Self {
        Self { error, call: None }
    }
}
impl CapturedClient {
    pub(crate) fn require_viewer_released(
        &self,
        job: &Arc<crate::worker_laptop::ViewerJob>,
    ) -> Result<()> {
        if !job.same_capture(&self.bootstrap) {
            return Err(EngineError::new(EngineFault::Identity));
        }
        let active = self.active.try_lock().map_err(|_| {
            EngineError::pending(EngineFault::Finalization, CleanupFault::Supervisor)
        })?;
        if matches!(active.as_ref(),Some(Active::ViewerConstructor(current)) if Arc::ptr_eq(current,job))
        {
            Err(EngineError::pending(
                EngineFault::Finalization,
                CleanupFault::PendingStart,
            ))
        } else {
            Ok(())
        }
    }
    #[cfg(test)]
    pub(crate) fn hold_cleanup_slot_for_owned_test(
        &self,
        gate: &super::test_hooks::Gate,
        job: &Arc<crate::worker_laptop::ViewerJob>,
        observed: std::sync::mpsc::Receiver<Instant>,
    ) -> super::test_hooks::CleanupSlotObservation {
        assert!(job.same_capture(&self.bootstrap));
        let active = self.active.lock().unwrap();
        gate.entered.store(true, Ordering::Release);
        let end = observed.recv_timeout(Duration::from_secs(3)).ok();
        let released_by_caller = loop {
            if gate.released.load(Ordering::Acquire) {
                break true;
            }
            // Controlled fallback lets the old unbounded implementation
            // return; it is not a product timer or renewed cleanup budget.
            if end.is_none_or(|end| Instant::now() >= end + Duration::from_millis(500)) {
                break false;
            }
            std::thread::sleep(Duration::from_millis(1));
        };
        let same_job = matches!(active.as_ref(),Some(Active::ViewerConstructor(current)) if Arc::ptr_eq(current,job));
        super::test_hooks::CleanupSlotObservation {
            end,
            released_by_caller,
            same_job,
        }
    }
    #[cfg(test)]
    pub(crate) fn hold_actual_slot_for_owned_test(&self, gate: &super::test_hooks::Gate) {
        let _slot = self.active.lock().unwrap();
        gate.entered.store(true, Ordering::Release);
        while !gate.released.load(Ordering::Acquire) {
            std::thread::sleep(Duration::from_millis(1));
        }
    }
    /// Share the service capture; interactive PTY ownership stays separate from
    /// this client's bounded PIPE query slot and cannot block metadata queries.
    pub(crate) fn viewer_capture(&self) -> Arc<InstalledCommand> {
        self.bootstrap.clone()
    }
    /// The same one-slot admission owner covers constructor custody. A fully
    /// handed-off interactive process is inventoried by its laptop record, so
    /// it does not occupy the PIPE query slot for its entire terminal lifetime.
    pub(crate) fn admit_viewer(&self, job: &Arc<crate::worker_laptop::ViewerJob>) -> Result<()> {
        if !job.same_capture(&self.bootstrap) {
            return Err(EngineError::new(EngineFault::Identity));
        }
        let mut active = self.admission_slot()?;
        if self.closing.load(Ordering::Acquire) {
            return Err(EngineError::new(EngineFault::Cancelled));
        }
        if active.is_some() {
            return Err(EngineError::before_start_pending(
                EngineFault::Busy,
                CleanupFault::PendingStart,
            ));
        }
        *active = Some(Active::ViewerConstructor(job.clone()));
        Ok(())
    }
    pub(crate) fn handoff_viewer(
        &self,
        job: &Arc<crate::worker_laptop::ViewerJob>,
        deadline: Instant,
    ) -> Result<()> {
        self.handoff_viewer_budget(job, Some(deadline))
    }
    pub(crate) fn handoff_viewer_for_worker(
        &self,
        job: &Arc<crate::worker_laptop::ViewerJob>,
    ) -> Result<()> {
        self.handoff_viewer_budget(job, None)
    }
    fn handoff_viewer_budget(
        &self,
        job: &Arc<crate::worker_laptop::ViewerJob>,
        deadline: Option<Instant>,
    ) -> Result<()> {
        if !job.same_capture(&self.bootstrap) {
            return Err(EngineError::new(EngineFault::Identity));
        }
        let mut active = self.viewer_slot(job, deadline)?;
        let same = matches!(active.as_ref(),Some(Active::ViewerConstructor(current)) if Arc::ptr_eq(current,job));
        if !same || self.closing.load(Ordering::Acquire) || !job.handoff_ready() {
            return Err(EngineError::pending(
                EngineFault::Finalization,
                CleanupFault::PendingStart,
            ));
        }
        *active = None;
        Ok(())
    }
    pub(crate) fn settle_viewer(
        &self,
        job: &Arc<crate::worker_laptop::ViewerJob>,
        deadline: Instant,
    ) -> Result<()> {
        if !job.same_capture(&self.bootstrap) {
            return Err(EngineError::new(EngineFault::Identity));
        }
        job.close_captured(deadline)
            .map_err(|_| EngineError::pending(EngineFault::Finalization, CleanupFault::Unreaped))?;
        let mut active = self.viewer_slot(job, Some(deadline))?;
        if matches!(active.as_ref(),Some(Active::ViewerConstructor(current)) if Arc::ptr_eq(current,job))
        {
            *active = None;
        }
        drop(active);
        self.require_viewer_released(job)
    }
    pub(crate) fn settle_viewer_for_worker(
        &self,
        job: &Arc<crate::worker_laptop::ViewerJob>,
        guard: Instant,
    ) -> Result<()> {
        if !job.same_capture(&self.bootstrap) {
            return Err(EngineError::new(EngineFault::Identity));
        }
        job.close_captured_for_worker(guard)
            .map_err(|_| EngineError::pending(EngineFault::Finalization, CleanupFault::Unreaped))?;
        let end = job
            .cleanup_deadline(guard)
            .map_err(|_| EngineError::pending(EngineFault::Finalization, CleanupFault::Unreaped))?;
        #[cfg(test)]
        super::test_hooks::viewer_release(end);
        let mut active = self.viewer_slot(job, Some(end))?;
        if matches!(active.as_ref(),Some(Active::ViewerConstructor(current)) if Arc::ptr_eq(current,job))
        {
            *active = None;
        }
        drop(active);
        self.require_viewer_released(job)
    }
    fn viewer_slot(
        &self,
        job: &crate::worker_laptop::ViewerJob,
        deadline: Option<Instant>,
    ) -> Result<std::sync::MutexGuard<'_, Option<Active>>> {
        loop {
            let end = viewer_deadline(job, deadline)?;
            if end.is_some_and(|end| Instant::now() >= end) {
                return Err(EngineError::pending(
                    EngineFault::Deadline,
                    CleanupFault::Supervisor,
                ));
            }
            match self.active.try_lock() {
                Ok(active) => return Ok(active),
                Err(TryLockError::Poisoned(_)) => {
                    return Err(EngineError::pending(
                        EngineFault::Supervisor,
                        CleanupFault::Supervisor,
                    ));
                }
                Err(TryLockError::WouldBlock) => match end {
                    Some(end) => tick(end),
                    None => std::thread::sleep(Duration::from_millis(1)),
                },
            }
        }
    }
    /// This does not clear a fence or turn a negative close into success. A
    /// standalone owner may terminate negatively only after all known native
    /// work is consumed; persistent services keep the same failed context.
    pub(crate) fn shutdown(
        &self,
        deadline: Instant,
    ) -> reverie_core::shutdown::ShutdownStatus<EngineError> {
        use reverie_core::shutdown::ShutdownStatus;
        match self.close(deadline) {
            Ok(()) => ShutdownStatus::Complete,
            Err(error) if self.has_pending_native_work() => ShutdownStatus::Pending(error),
            Err(error) => ShutdownStatus::Refused(error),
        }
    }
    fn has_pending_native_work(&self) -> bool {
        // Failed admission sealing, mutex contention and poison are unknown,
        // never evidence that another constructor cannot still be admitted.
        if !self.closing.load(Ordering::Acquire) {
            return true;
        }
        let Ok(active) = self.active.try_lock() else {
            return true;
        };
        let Some(current) = &*active else {
            return false;
        };
        let Active::Query(job) = current else {
            let Active::ViewerConstructor(job) = current else {
                unreachable!()
            };
            return job.has_pending_native_work();
        };
        // The accepted worker publishes this only after start/observe/catch
        // and cleanup. All its native resources reside in this JobData; there
        // is no separate unadopted constructor JoinHandle/result here.
        job.has_pending_native_work()
    }
    pub(crate) fn new(bootstrap: InstalledCommand) -> Self {
        Self {
            bootstrap: Arc::new(bootstrap),
            active: Mutex::new(None),
            closing: AtomicBool::new(false),
        }
    }
    /// Only closed purpose wrappers supply argv and a fixed private policy.
    /// All purposes sharing this context use the same retained-job admission.
    pub(crate) fn run(
        &self,
        args: Vec<OsString>,
        deadline: Instant,
        cancellation: &CancellationToken,
        policy: Policy,
    ) -> Result<CapturedOutput> {
        self.run_scoped_waiting(args, deadline, cancellation, policy)
            .map_err(|failure| failure.error)
    }
    pub(crate) fn run_scoped(
        &self,
        args: Vec<OsString>,
        deadline: Instant,
        cancellation: &CancellationToken,
        policy: Policy,
    ) -> std::result::Result<CapturedOutput, CallFailure> {
        self.run_owned(
            args,
            deadline,
            cancellation,
            policy,
            &mut None,
            ExecutionMode::Combined,
        )
    }
    /// Fixed pure controller decoder only. The original bounded birth input is
    /// consumed by Process before spawn, using the same checked input custody.
    pub(crate) fn check_controller_birth(
        &self,
        deadline: Instant,
        cancellation: &CancellationToken,
        input: &mut Option<std::fs::File>,
    ) -> std::result::Result<CapturedOutput, CallFailure> {
        self.run_owned(
            vec!["check-birth".into()],
            deadline,
            cancellation,
            Policy {
                maximum: std::time::Duration::from_secs(10),
                maximum_output: 4096,
                successful_exit: true,
            },
            input,
            ExecutionMode::CombinedWaiting,
        )
    }
    /// Fixed metadata readers own this whole bounded query window. Effect
    /// owners with their own live stop/admission loop use immediate run_scoped.
    pub(crate) fn run_scoped_waiting(
        &self,
        args: Vec<OsString>,
        deadline: Instant,
        cancellation: &CancellationToken,
        policy: Policy,
    ) -> std::result::Result<CapturedOutput, CallFailure> {
        self.run_owned(
            args,
            deadline,
            cancellation,
            policy,
            &mut None,
            ExecutionMode::CombinedWaiting,
        )
    }
    /// Goal's existing fixed inventory discards stderr in the child. Keep the
    /// same native registry, one admitted job and all checked finalizers.
    pub(crate) fn run_goal_inventory(
        &self,
        args: Vec<OsString>,
        deadline: Instant,
        cancellation: &CancellationToken,
        policy: Policy,
    ) -> std::result::Result<CapturedOutput, CallFailure> {
        self.run_owned(
            args,
            deadline,
            cancellation,
            policy,
            &mut None,
            ExecutionMode::GoalStdout,
        )
    }
    /// The closed GPU preflight reader accepts JSON bytes (including Python's
    /// byte-JSON BOM encodings) and discards stderr at spawn. It retains the
    /// same admitted native job, absolute deadline and checked finalizers.
    pub(crate) fn run_gpu_preflight(
        &self,
        args: Vec<OsString>,
        deadline: Instant,
        cancellation: &CancellationToken,
        policy: Policy,
    ) -> std::result::Result<CapturedOutput, CallFailure> {
        self.run_owned(
            args,
            deadline,
            cancellation,
            policy,
            &mut None,
            ExecutionMode::GpuPreflightStdout,
        )
    }
    /// The closed guest bootstrap alone streams a one-shot installed
    /// registration file and retains diagnostic tails. Failed admission leaves
    /// input with its caller; admitted input belongs to Process before the
    /// constructor thread can start, including delayed/failed constructors.
    pub(crate) fn run_nix_bootstrap(
        &self,
        args: Vec<OsString>,
        deadline: Instant,
        cancellation: &CancellationToken,
        registration: &mut Option<std::fs::File>,
    ) -> Result<CapturedOutput> {
        self.run_owned(
            args,
            deadline,
            cancellation,
            Policy {
                maximum: deadline.saturating_duration_since(Instant::now()),
                maximum_output: 0,
                successful_exit: false,
            },
            registration,
            ExecutionMode::NixTail,
        )
        .map_err(|failure| failure.error)
    }
    fn run_owned(
        &self,
        args: Vec<OsString>,
        deadline: Instant,
        cancellation: &CancellationToken,
        policy: Policy,
        registration: &mut Option<std::fs::File>,
        mode: ExecutionMode,
    ) -> std::result::Result<CapturedOutput, CallFailure> {
        let deadline = deadline.min(
            Instant::now()
                .checked_add(policy.maximum)
                .unwrap_or(deadline),
        );
        if cancellation.is_cancelled() {
            return Err(CallFailure::before_admission(EngineError::new(
                EngineFault::Cancelled,
            )));
        }
        if Instant::now() >= deadline {
            return Err(CallFailure::before_admission(EngineError::new(
                EngineFault::Deadline,
            )));
        }
        // The existing viewer admission strategy also waits only BEFORE any
        // native constructor starts. Keep this call's original clipped end;
        // never settle/cancel a sibling or retry an admitted command.
        let call = loop {
            if cancellation.is_cancelled() || Instant::now() >= deadline {
                return Err(CallFailure::before_admission(EngineError::new(
                    cancellation_fault(cancellation.is_cancelled()),
                )));
            }
            match self.admit(cancellation, policy, registration, mode) {
                Ok(call) => break call,
                Err(error)
                    if matches!(
                        mode,
                        ExecutionMode::CombinedWaiting
                            | ExecutionMode::GoalStdout
                            | ExecutionMode::GpuPreflightStdout
                    ) && error.is_admission_busy() =>
                {
                    #[cfg(test)]
                    self.bootstrap
                        .hooks
                        .admission_waited
                        .store(true, Ordering::Release);
                    tick(deadline);
                }
                Err(error) => return Err(CallFailure::before_admission(error)),
            }
        };
        self.run_admitted(args, deadline, &call.job)
            .map_err(|error| CallFailure {
                error,
                call: Some(call),
            })
    }
    fn run_admitted(
        &self,
        args: Vec<OsString>,
        deadline: Instant,
        job: &Arc<Job>,
    ) -> Result<CapturedOutput> {
        let bootstrap = Arc::clone(&self.bootstrap);
        let owned = Arc::clone(job);
        if std::thread::Builder::new()
            .name("reverie-captured-client".into())
            .spawn(move || execute(bootstrap, args, deadline, owned))
            .is_err()
        {
            let mut data = job
                .data
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            data.result = Some(data.process.finish(
                Err(EngineError::new(EngineFault::Supervisor)),
                deadline,
                job,
            ));
            drop(data);
            job.finished.store(true, Ordering::Release);
            return self.result(job, deadline);
        }
        loop {
            if job.finished.load(Ordering::Acquire) {
                return self.result(job, deadline);
            }
            if job.cancelled() || Instant::now() >= deadline {
                let fault = cancellation_fault(job.cancelled());
                job.abort.store(true, Ordering::Release);
                return Err(EngineError::pending(fault, CleanupFault::PendingStart));
            }
            tick(deadline);
        }
    }
    fn admit(
        &self,
        external: &CancellationToken,
        policy: Policy,
        registration: &mut Option<std::fs::File>,
        mode: ExecutionMode,
    ) -> Result<CapturedCall> {
        let mut active = self.admission_slot()?;
        if self.closing.load(Ordering::Acquire) {
            return Err(if active.is_some() {
                EngineError::pending(EngineFault::Busy, CleanupFault::Unreaped)
            } else {
                EngineError::new(EngineFault::Busy)
            });
        }
        if active.is_some() {
            return Err(EngineError::before_start_pending(
                EngineFault::Busy,
                CleanupFault::Unreaped,
            ));
        }
        let job = Arc::new(Job {
            external: external.clone(),
            abort: AtomicBool::new(false),
            finished: AtomicBool::new(false),
            data: Mutex::new(JobData {
                process: Process::with_registration(registration.take()),
                result: None,
            }),
            policy,
            nix_tail: matches!(mode, ExecutionMode::NixTail),
            stdout_only: matches!(
                mode,
                ExecutionMode::GoalStdout | ExecutionMode::GpuPreflightStdout
            ),
            raw_stdout: matches!(mode, ExecutionMode::GpuPreflightStdout),
            #[cfg(test)]
            hooks: self.bootstrap.hooks.clone(),
        });
        *active = Some(Active::Query(Arc::clone(&job)));
        Ok(CapturedCall {
            origin: Arc::clone(&self.bootstrap),
            job,
        })
    }
    fn admission_slot(&self) -> Result<std::sync::MutexGuard<'_, Option<Active>>> {
        match self.active.try_lock() {
            Ok(active) => Ok(active),
            Err(TryLockError::WouldBlock) => Err(EngineError::before_start_pending(
                EngineFault::Busy,
                CleanupFault::Supervisor,
            )),
            Err(TryLockError::Poisoned(_)) => Err(EngineError::pending(
                EngineFault::Supervisor,
                CleanupFault::Supervisor,
            )),
        }
    }
    fn release(&self, job: &Arc<Job>, deadline: Instant) -> Result<()> {
        // Only the exact completed job is handed off. Waiting for this RAM
        // mutex is not another admission or native query. Preserve the caller's
        // original deadline and retain its result until the handoff succeeds.
        let mut active = loop {
            match self.active.try_lock() {
                Ok(active) => break active,
                Err(TryLockError::Poisoned(_)) => {
                    return Err(EngineError::pending(
                        EngineFault::Supervisor,
                        CleanupFault::Supervisor,
                    ));
                }
                Err(TryLockError::WouldBlock) => {
                    #[cfg(test)]
                    job.hooks.handoff_contended.store(true, Ordering::Release);
                }
            }
            if Instant::now() >= deadline {
                return Err(EngineError::pending(
                    EngineFault::Deadline,
                    CleanupFault::Supervisor,
                ));
            }
            tick(deadline);
        };
        if active.as_ref().is_some_and(
            |current| matches!(current,Active::Query(current) if Arc::ptr_eq(current, job)),
        ) {
            *active = None;
        }
        Ok(())
    }
    fn result(&self, job: &Arc<Job>, deadline: Instant) -> Result<CapturedOutput> {
        #[cfg(test)]
        job.hooks.before_result();
        let mut data = job
            .data
            .try_lock()
            .map_err(|_| EngineError::pending(EngineFault::Supervisor, CleanupFault::Supervisor))?;
        let result = data.result.as_ref().ok_or_else(|| {
            EngineError::pending(EngineFault::Supervisor, CleanupFault::Supervisor)
        })?;
        let retained = result.as_ref().err().is_some_and(EngineError::is_uncertain);
        if !retained {
            self.release(job, deadline)?;
        }
        let result = data.result.take().expect("same locked completed result");
        if job.cancelled() || Instant::now() >= deadline {
            let fault = cancellation_fault(job.cancelled());
            return Err(data.process.report(EngineError::new(fault)));
        }
        result
    }
    /// Settle only retained exact clients/pipe writers under a supplied shutdown
    /// budget. It never repeats an engine query or changes its failed outcome.
    pub(crate) fn settle_owned(&self, deadline: Instant) -> Result<()> {
        let job = self
            .active
            .try_lock()
            .map_err(|_| EngineError::pending(EngineFault::Supervisor, CleanupFault::Supervisor))?
            .clone();
        let Some(job) = job else {
            return Ok(());
        };
        match job {
            Active::Query(job) => self.settle_job(&job, deadline),
            Active::ViewerConstructor(job) => self.settle_viewer(&job, deadline),
        }
    }
    pub(crate) fn settle_call(&self, call: &CapturedCall, deadline: Instant) -> Result<()> {
        if !Arc::ptr_eq(&self.bootstrap, &call.origin) {
            return Err(EngineError::new(EngineFault::Identity));
        }
        self.settle_job(&call.job, deadline)
    }
    fn settle_job(&self, job: &Arc<Job>, deadline: Instant) -> Result<()> {
        job.abort.store(true, Ordering::Release);
        loop {
            if job.finished.load(Ordering::Acquire) {
                return self.settle_finished(job, deadline);
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
    /// Permanently close admission under the same mutex that admits a job,
    /// then settle only the exact retained process. This never reissues argv.
    pub(crate) fn close(&self, deadline: Instant) -> Result<()> {
        let active = self
            .active
            .try_lock()
            .map_err(|_| EngineError::pending(EngineFault::Supervisor, CleanupFault::Supervisor))?;
        self.closing.store(true, Ordering::Release);
        drop(active);
        self.settle_owned(deadline)
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
        self.release(job, deadline)
    }
}
fn viewer_deadline(
    job: &crate::worker_laptop::ViewerJob,
    deadline: Option<Instant>,
) -> Result<Option<Instant>> {
    job.constructor_deadline(deadline)
        .map_err(|_| EngineError::pending(EngineFault::Identity, CleanupFault::Identity))
}
impl Drop for CapturedClient {
    fn drop(&mut self) {
        if let Ok(Some(job)) = self.active.get_mut() {
            match job {
                Active::Query(job) => job.abort.store(true, Ordering::Release),
                Active::ViewerConstructor(job) => job.request_close(),
            }
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
fn execute(
    bootstrap: Arc<InstalledCommand>,
    args: Vec<OsString>,
    deadline: Instant,
    job: Arc<Job>,
) {
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
                .start(&bootstrap, &args, &job)
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
