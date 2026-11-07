//! A concrete PTY attach constructor installed in the laptop record BEFORE
//! thread creation. No thread/late spawn can outlive its retained native owner.
use super::*;
mod terminal;
use crate::{
    captured_client::InstalledCommand, native::viewer_session::ViewerProcess,
    terminal_pty::OwnedPty,
};
use std::{
    ffi::OsString,
    sync::atomic::{AtomicBool, Ordering},
    thread::JoinHandle,
    time::Duration,
};
pub(in crate::worker_laptop) use terminal::{Query, QueryObservation};

struct State {
    process: ViewerProcess,
    pty: Option<OwnedPty>,
    failure: Option<Arc<LaptopError>>,
    cleanup_failure: Option<Arc<LaptopError>>,
    opaque: bool,
    term_sent: bool,
    transport: Option<terminal::Transport>,
    receipt: Option<std::fs::File>,
}
struct ClosePlan {
    end: Instant,
    term: Instant,
    kill: Option<Instant>,
}
pub(crate) struct Job {
    capture: Arc<InstalledCommand>,
    origin: std::sync::Weak<InstalledWorkerEngine>,
    name: reverie_core::worker_launch::WorkerName,
    size: TerminalSize,
    marker: [u8; 16],
    source: Option<crate::worker_reports::terminal::RelayIdentity>,
    state: Mutex<State>,
    thread: Mutex<Option<JoinHandle<()>>>,
    done: AtomicBool,
    closing: AtomicBool,
    close: Mutex<Option<ClosePlan>>,
    #[cfg(test)]
    gate: Option<Arc<crate::captured_client::test_hooks::Gate>>,
}
impl Job {
    pub(in crate::worker_laptop) fn new(
        runtime: &WorkerRuntime,
        name: reverie_core::worker_launch::WorkerName,
        size: TerminalSize,
        marker: [u8; 16],
        source: Option<crate::worker_reports::terminal::RelayIdentity>,
    ) -> Arc<Self> {
        let process = ViewerProcess::default();
        #[cfg(test)]
        let mut process = process;
        #[cfg(test)]
        if super::test_hooks::input_close_failure() {
            process.refuse_input_close();
        }
        #[cfg(test)]
        if super::test_hooks::group_failure() {
            process.refuse_group_result();
        }
        #[cfg(test)]
        if super::test_hooks::probe_failure() {
            process.refuse_probe_result();
        }
        Arc::new(Self {
            capture: runtime.installed_engine().engine.client.viewer_capture(),
            origin: Arc::downgrade(runtime.installed_engine()),
            name,
            size,
            marker,
            source,
            state: Mutex::new(State {
                process,
                pty: None,
                failure: None,
                cleanup_failure: None,
                opaque: false,
                term_sent: false,
                transport: None,
                receipt: None,
            }),
            thread: Mutex::new(None),
            done: AtomicBool::new(false),
            closing: AtomicBool::new(false),
            close: Mutex::new(None),
            #[cfg(test)]
            gate: super::test_hooks::take_gate(),
        })
    }
    pub(super) fn launch(
        self: &Arc<Self>,
        cancellation: crate::captured_client::CancellationToken,
    ) {
        let args = match network::encode_arguments(
            &reverie_contracts::worker_launch::viewer_attach_arguments(
                &ContainerReference::Worker(&self.name),
                &self.marker,
            ),
        ) {
            Ok(args) => args,
            Err(error) => {
                self.refused_before_admission(Arc::new(error));
                return;
            }
        };
        let job = self.clone();
        match std::thread::Builder::new()
            .name("reverie-viewer-start".into())
            .spawn(move || {
                let mut state = job.state.lock().expect("private constructor state");
                let result = job.construct(&mut state, &args, job.size, &cancellation);
                if let Err(error) = result {
                    state.opaque |= uncertain_terminal(&error);
                    state.failure = Some(Arc::new(error));
                }
                drop(state);
                job.done.store(true, Ordering::Release);
            }) {
            Ok(thread) => *self.thread.lock().expect("new job thread owner") = Some(thread),
            Err(error) => {
                self.state.lock().expect("unstarted job").failure =
                    Some(Arc::new(LaptopError::Io(error)));
                self.done.store(true, Ordering::Release);
            }
        }
    }
    pub(super) fn refused_before_admission(&self, error: Arc<LaptopError>) {
        self.state.lock().expect("unstarted native owner").failure = Some(error);
        self.done.store(true, Ordering::Release);
    }
    fn construct(
        &self,
        state: &mut State,
        args: &[OsString],
        size: TerminalSize,
        cancellation: &crate::captured_client::CancellationToken,
    ) -> Result<()> {
        self.may_start(cancellation)?;
        state.pty = Some(OwnedPty::open(size).map_err(LaptopError::Terminal)?);
        state
            .process
            .prepare(
                state
                    .pty
                    .as_ref()
                    .expect("new PTY")
                    .slave_fd()
                    .map_err(LaptopError::Io)?,
            )
            .map_err(LaptopError::Io)?;
        let mut command = self.capture.viewer_command(args).map_err(LaptopError::Io)?;
        state.process.configure(&mut command);
        self.capture
            .configure_viewer_exact(&mut command, args)
            .map_err(LaptopError::Io)?;
        self.may_start(cancellation)?;
        #[cfg(test)]
        if let Some(gate) = &self.gate {
            gate.entered.store(true, Ordering::Release);
            while !gate.released.load(Ordering::Acquire) {
                std::thread::sleep(Duration::from_millis(1));
            }
        }
        let result = state.process.spawn(&mut command).map_err(LaptopError::Io);
        let slave = state
            .pty
            .as_mut()
            .expect("owned PTY")
            .close_slave()
            .map_err(LaptopError::Terminal);
        finalized(result, slave)
    }
    fn may_start(&self, cancellation: &crate::captured_client::CancellationToken) -> Result<()> {
        need(
            !self.closing.load(Ordering::Acquire)
                && !cancellation.is_cancelled()
                && self
                    .source
                    .as_ref()
                    .is_none_or(crate::worker_reports::terminal::RelayIdentity::can_progress),
            "WORKER_VIEWER_STOPPED",
        )
    }
    fn join(&self) -> Result<bool> {
        if !self.done.load(Ordering::Acquire) {
            return Ok(false);
        }
        let mut thread = self
            .thread
            .try_lock()
            .map_err(|_| LaptopError::Refused("VIEWER_START_PENDING"))?;
        if thread.as_ref().is_some_and(|task| !task.is_finished()) {
            return Ok(false);
        }
        if let Some(task) = thread.take() {
            need(task.join().is_ok(), "VIEWER_CONSTRUCTOR_UNCONFIRMED")?;
        }
        Ok(true)
    }
    pub(crate) fn same_capture(&self, capture: &Arc<InstalledCommand>) -> bool {
        Arc::ptr_eq(&self.capture, capture)
    }
    pub(crate) fn handoff_ready(&self) -> bool {
        if !matches!(self.join(), Ok(true)) || self.closing.load(Ordering::Acquire) {
            return false;
        }
        if self
            .source
            .as_ref()
            .is_some_and(|source| !source.can_progress())
        {
            return false;
        }
        if self
            .origin
            .upgrade()
            .is_none_or(|origin| origin.cancellation().is_cancelled())
        {
            return false;
        }
        self.state.try_lock().is_ok_and(|state| {
            state.failure.is_none() && state.pty.is_some() && state.process.handoff_ready()
        })
    }
    pub(crate) fn request_close(&self) {
        self.closing.store(true, Ordering::Release);
    }
    pub(crate) fn clamp_deadline(&self, requested: Instant) -> Result<Instant> {
        let origin = self
            .origin
            .upgrade()
            .ok_or(LaptopError::Refused("VIEWER_ORIGIN_RETAINED"))?;
        Ok(origin
            .stop_deadline()
            .map_or(requested, |stop| stop.min(requested)))
    }
    pub(super) fn wait_started(&self, runtime: &WorkerRuntime, ceiling: Instant) -> Result<bool> {
        loop {
            if self.join()? {
                need(
                    Instant::now() < clipped(runtime, ceiling)
                        && !runtime.cancellation().is_cancelled(),
                    "VIEWER_START_PENDING",
                )?;
                let state = self
                    .state
                    .try_lock()
                    .map_err(|_| LaptopError::Refused("VIEWER_START_PENDING"))?;
                return Ok(state.failure.is_none());
            }
            let end = clipped(runtime, ceiling);
            need(
                Instant::now() < end && !runtime.cancellation().is_cancelled(),
                "VIEWER_START_PENDING",
            )?;
            std::thread::sleep(Duration::from_millis(1));
        }
    }
    pub(in crate::worker_laptop) fn failure(&self) -> Result<Option<Arc<LaptopError>>> {
        let state = self
            .state
            .try_lock()
            .map_err(|_| LaptopError::Refused("VIEWER_START_PENDING"))?;
        Ok(match (&state.failure, &state.cleanup_failure) {
            (Some(primary), Some(secondary)) => Some(Arc::new(LaptopError::Finalization {
                primary: Box::new(LaptopError::Recorded(primary.clone())),
                secondary: Box::new(LaptopError::Recorded(secondary.clone())),
            })),
            (Some(error), None) | (None, Some(error)) => Some(error.clone()),
            (None, None) => None,
        })
    }
    #[cfg(test)]
    pub(in crate::worker_laptop) fn external_reap(&self) -> Result<()> {
        let state = self.state.lock().unwrap();
        need(
            state
                .process
                .external_reap()
                .map_err(LaptopError::Io)?
                .is_some(),
            "TEST_CHILD_STILL_RUNNING",
        )
    }
    #[cfg(test)]
    pub(in crate::worker_laptop) fn native_counts(&self) -> (usize, usize) {
        self.state.lock().unwrap().process.test_counts()
    }
    #[cfg(test)]
    pub(in crate::worker_laptop) fn test_group_pending(&self) -> bool {
        self.state.lock().unwrap().process.has_pending_native_work()
    }
    #[cfg(test)]
    pub(in crate::worker_laptop) fn test_probe_count(&self) -> usize {
        self.state.lock().unwrap().process.test_probes()
    }
    #[cfg(test)]
    pub(in crate::worker_laptop) fn test_identity_consumed(&self) -> bool {
        self.state.lock().unwrap().process.test_identity_consumed()
    }
    #[cfg(test)]
    pub(in crate::worker_laptop) fn test_post_reap_group_signal(&self) -> Result<()> {
        self.state
            .lock()
            .unwrap()
            .process
            .kill_group()
            .map_err(LaptopError::Io)
    }
    #[cfg(test)]
    pub(in crate::worker_laptop) fn test_kill_end(&self) -> Instant {
        self.close.lock().unwrap().as_ref().unwrap().kill.unwrap()
    }
    #[cfg(test)]
    pub(in crate::worker_laptop) fn test_reap_exited(&self) -> Result<()> {
        // Owning fixture cleanup AFTER assertions of the actual expired product
        // budget/refusal. No signal/new grace; never used as product release.
        need(self.join()?, "TEST_CONSTRUCTOR_PENDING")?;
        let mut state = self.state.lock().unwrap();
        need(
            state
                .process
                .test_reap_abandoned()
                .map_err(LaptopError::Io)?,
            "TEST_CHILD_STILL_RUNNING",
        )?;
        if let Some(pty) = state.pty.take() {
            pty.close().map_err(LaptopError::Terminal)?;
        }
        Ok(())
    }
    pub(super) fn read(&self, bytes: &mut [u8]) -> Result<usize> {
        let state = self
            .state
            .try_lock()
            .map_err(|_| LaptopError::Refused("VIEWER_BUSY"))?;
        state
            .pty
            .as_ref()
            .ok_or(LaptopError::Refused("VIEWER_CLOSED"))?
            .try_read(bytes)
            .map_err(LaptopError::Io)
    }
    pub(super) fn write(&self, bytes: &[u8]) -> Result<usize> {
        #[cfg(test)]
        super::test_hooks::before_write();
        let state = self
            .state
            .try_lock()
            .map_err(|_| LaptopError::Refused("VIEWER_BUSY"))?;
        state
            .pty
            .as_ref()
            .ok_or(LaptopError::Refused("VIEWER_CLOSED"))?
            .try_write(bytes)
            .map_err(LaptopError::Io)
    }
    pub(super) fn resize(&self, size: TerminalSize) -> Result<()> {
        let state = self
            .state
            .try_lock()
            .map_err(|_| LaptopError::Refused("VIEWER_BUSY"))?;
        need(!self.closing.load(Ordering::Acquire), "VIEWER_CLOSED")?;
        state
            .pty
            .as_ref()
            .ok_or(LaptopError::Refused("VIEWER_CLOSED"))?
            .resize(size)
            .map_err(LaptopError::Io)?;
        state.process.winch().map_err(LaptopError::Io)
    }
    pub(in crate::worker_laptop) fn status(&self) -> Result<Option<i32>> {
        let state = self
            .state
            .try_lock()
            .map_err(|_| LaptopError::Refused("VIEWER_BUSY"))?;
        Ok(state
            .process
            .peek()
            .map_err(LaptopError::Io)?
            .map(|status| match status {
                crate::native::owned_process::ProcessStatus::Exited(code) => i32::from(code),
                crate::native::owned_process::ProcessStatus::Signaled(signal) => -signal,
            }))
    }
    pub(in crate::worker_laptop) fn close(
        &self,
        runtime: &WorkerRuntime,
        requested: Instant,
    ) -> Result<()> {
        let origin = self
            .origin
            .upgrade()
            .ok_or(LaptopError::Refused("VIEWER_ORIGIN_RETAINED"))?;
        need(
            Arc::ptr_eq(&origin, runtime.installed_engine()),
            "WORKER_VIEWER_ORIGIN",
        )?;
        self.close_captured(requested)
    }
    pub(crate) fn close_captured(&self, requested: Instant) -> Result<()> {
        self.closing.store(true, Ordering::Release);
        let mut plan = self
            .close
            .try_lock()
            .map_err(|_| LaptopError::Refused("VIEWER_UNREAPED"))?;
        let plan = plan.get_or_insert_with(|| ClosePlan {
            end: requested,
            term: (Instant::now() + Duration::from_secs(5)).min(requested),
            kill: None,
        });
        loop {
            let bound = plan.end.min(requested);
            let end = self.clamp_deadline(bound)?;
            let end = plan.kill.map_or(end, |kill| end.min(kill));
            if self.join()? && self.close_step(plan, end)? {
                return Ok(());
            }
            need(Instant::now() < end, "VIEWER_UNREAPED")?;
            std::thread::sleep(Duration::from_millis(1));
        }
    }
    fn close_step(&self, plan: &mut ClosePlan, end: Instant) -> Result<bool> {
        let Ok(mut state) = self.state.try_lock() else {
            return Ok(false);
        };
        let query = match &mut state.transport {
            Some(transport) => self
                .origin
                .upgrade()
                .ok_or(LaptopError::Refused("VIEWER_ORIGIN_RETAINED"))
                .and_then(|origin| transport.settle(&origin, end)),
            None => Ok(()),
        };
        // A refused query settlement cannot hide the actual viewer group.
        // Attempt both under the SAME first cleanup budget, retaining causes.
        let native = step(&mut state, plan, end);
        let done = native.as_ref().is_ok_and(|done| *done);
        let result = finalized(query, native.map(|_| ())).map(|()| done);
        match result {
            Ok(done) => Ok(done),
            Err(error) => {
                let error = Arc::new(error);
                if state.cleanup_failure.is_none() {
                    state.cleanup_failure = Some(error.clone());
                }
                Err(LaptopError::Recorded(error))
            }
        }
    }
    pub(crate) fn has_pending_native_work(&self) -> bool {
        if !self.done.load(Ordering::Acquire) {
            return true;
        }
        if self
            .thread
            .try_lock()
            .map_or(true, |thread| thread.is_some())
        {
            return true;
        }
        self.state.try_lock().map_or(true, |state| {
            state.pty.is_some()
                || state.receipt.is_some()
                || state.process.has_pending_native_work()
                || state
                    .transport
                    .as_ref()
                    .is_some_and(terminal::Transport::has_pending_native_work)
        })
    }
}
fn step(state: &mut State, plan: &mut ClosePlan, end: Instant) -> Result<bool> {
    if state.process.settled() && state.pty.is_none() && !state.opaque {
        return Ok(true);
    }
    need(Instant::now() < end, "VIEWER_UNREAPED")?;
    state.process.finish_preparation();
    let exited = state.process.peek().map_err(LaptopError::Io)?.is_some();
    if !exited && !state.process.settled() {
        need(Instant::now() < end, "VIEWER_UNREAPED")?;
        if !state.term_sent {
            state.term_sent = true;
            state.process.terminate().map_err(LaptopError::Io)?;
        }
    }
    // Compatibility correction: leader exit is not group completion. Keep its
    // WNOWAIT pin through the final one-shot owned-group KILL decision even
    // after TERM succeeded or the leader had already exited before close.
    if state.process.needs_group_decision() && (exited || Instant::now() >= plan.term) {
        plan.kill = Some((Instant::now() + Duration::from_millis(100)).min(end));
        state.process.kill_group().map_err(LaptopError::Io)?;
    }
    let end = plan.kill.map_or(end, |kill| end.min(kill));
    need(Instant::now() < end, "VIEWER_UNREAPED")?;
    if !state.process.reap().map_err(LaptopError::Io)? {
        return Ok(false);
    }
    if let Some(pty) = state.pty.take()
        && let Err(error) = pty.close()
    {
        state.opaque = true;
        let close = Arc::new(LaptopError::Terminal(error));
        state.failure = Some(match state.failure.take() {
            Some(primary) => Arc::new(LaptopError::Finalization {
                primary: Box::new(LaptopError::Recorded(primary)),
                secondary: Box::new(LaptopError::Recorded(close)),
            }),
            None => close,
        });
    }
    if !state
        .process
        .observe_group_absent()
        .map_err(LaptopError::Io)?
    {
        return Ok(false);
    }
    need(!state.opaque && state.process.settled(), "VIEWER_UNREAPED")?;
    Ok(true)
}
pub(in crate::worker_laptop) fn clipped(runtime: &WorkerRuntime, end: Instant) -> Instant {
    runtime.stop_deadline().map_or(end, |stop| stop.min(end))
}
fn uncertain_terminal(error: &LaptopError) -> bool {
    match error {
        LaptopError::Terminal(error) => error.close_uncertain(),
        LaptopError::Finalization { primary, secondary } => {
            uncertain_terminal(primary) || uncertain_terminal(secondary)
        }
        _ => false,
    }
}
