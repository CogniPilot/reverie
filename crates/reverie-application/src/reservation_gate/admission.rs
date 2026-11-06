use super::*;
use std::time::Duration;
/// Monotonic installing-service bounds. Entry waiting is bounded independently
/// from the operation body; neither path creates a protected start capability.
#[derive(Clone, Copy, Default)]
pub struct AdmissionBounds {
    pub operation: Option<Instant>,
    pub entry: Option<Instant>,
}
impl AdmissionBounds {
    fn validate(self) -> Result<Option<Instant>> {
        let now = Instant::now();
        for end in [self.operation, self.entry].into_iter().flatten() {
            need(
                end > now && end.duration_since(now) <= Duration::from_secs(3600),
                "RESERVATION_ADMISSION_DEADLINE",
            )?;
        }
        Ok([self.operation, self.entry].into_iter().flatten().min())
    }
}
pub(super) struct Admission {
    gate: Arc<Inner>,
    active: Arc<Active>,
    finished: bool,
    _thread: std::marker::PhantomData<std::rc::Rc<()>>,
}
pub(super) struct Entering {
    thread: ThreadId,
    process: u32,
    token: Arc<()>,
}
pub(super) struct Entry {
    gate: Arc<Inner>,
    token: Arc<()>,
    finished: bool,
    _thread: std::marker::PhantomData<std::rc::Rc<()>>,
}
impl Inner {
    pub(super) fn admit(self: &Arc<Self>, bounds: AdmissionBounds) -> Result<Admission> {
        self.admit_selected(bounds, None)
    }
    pub(super) fn admit_launch(
        self: &Arc<Self>,
        bounds: AdmissionBounds,
        session: &reverie_core::ids::ProfileSessionId,
    ) -> Result<Admission> {
        self.admit_selected(bounds, Some(session))
    }
    fn admit_selected(
        self: &Arc<Self>,
        bounds: AdmissionBounds,
        ordinary_session: Option<&reverie_core::ids::ProfileSessionId>,
    ) -> Result<Admission> {
        let end = bounds.validate()?;
        let entry = self.reserve_entry(end)?;
        // Never hold the waiting-state mutex across filesystem I/O. Another
        // thread's bounded wait must remain bounded while this open stalls.
        let config = match self.config() {
            Ok(config) => config,
            Err(error) => return finalized(Err(error), entry.cancel()),
        };
        let lock = match AdmissionLock::acquire(&config) {
            Ok(lock) => lock,
            Err(error) => return finalized(Err(error.into()), entry.cancel()),
        };
        let active = Arc::new(Active {
            thread: std::thread::current().id(),
            process: std::process::id(),
            lock: Mutex::new(lock),
            context: Mutex::new(self.observer.capture(config.configuration().clone(), None)),
            deadline: Mutex::new(end),
            policy_ack: Mutex::new(None),
        });
        let admission = entry.activate(active)?;
        let entered = (|| {
            self.guard(None)?;
            // The fixed ordinary SID/journal phase is still entry work. Do not
            // clear entered_by before it or renew it after a slow observation.
            if let Some(session) = ordinary_session {
                self.check_ordinary_launch(session)?;
            }
            need(
                end.is_none_or(|end| Instant::now() < end),
                "RESERVATION_ADMISSION_DEADLINE",
            )?;
            *admission
                .active
                .deadline
                .lock()
                .map_err(|_| GateError::Refused("RESERVATION_ADMISSION_UNAVAILABLE"))? =
                bounds.operation;
            Ok(())
        })();
        match entered {
            Ok(()) => Ok(admission),
            Err(error) => finalized(Err(error), admission.abort()),
        }
    }
    pub(super) fn reserve_entry(self: &Arc<Self>, end: Option<Instant>) -> Result<Entry> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| GateError::Refused("RESERVATION_ADMISSION_UNAVAILABLE"))?;
        while state.active.is_some() || state.entering.is_some() {
            need(
                !state.active.as_ref().is_some_and(|active| {
                    active.thread == std::thread::current().id()
                        && active.process == std::process::id()
                }) && !state.entering.as_ref().is_some_and(|entry| {
                    entry.thread == std::thread::current().id()
                        && entry.process == std::process::id()
                }),
                "RESERVATION_REENTRANT_ADMISSION",
            )?;
            state = if let Some(end) = end {
                let left = end
                    .checked_duration_since(Instant::now())
                    .ok_or(GateError::Refused("RESERVATION_ADMISSION_DEADLINE"))?;
                let (state, timeout) = self
                    .changed
                    .wait_timeout(state, left)
                    .map_err(|_| GateError::Refused("RESERVATION_ADMISSION_UNAVAILABLE"))?;
                need(
                    !timeout.timed_out() && Instant::now() < end,
                    "RESERVATION_ADMISSION_DEADLINE",
                )?;
                state
            } else {
                self.changed
                    .wait(state)
                    .map_err(|_| GateError::Refused("RESERVATION_ADMISSION_UNAVAILABLE"))?
            };
        }
        let token = Arc::new(());
        state.entering = Some(Entering {
            thread: std::thread::current().id(),
            process: std::process::id(),
            token: token.clone(),
        });
        Ok(Entry {
            gate: self.clone(),
            token,
            finished: false,
            _thread: std::marker::PhantomData,
        })
    }
}
impl Admission {
    /// Python's context-manager body exception skips success/terminal native
    /// work and proceeds directly to mandatory owned cleanup.
    pub(super) fn conclude<T>(self, result: Result<T>) -> Result<T> {
        match result {
            Ok(value) => finalized(Ok(value), self.finish()),
            Err(error) => finalized(Err(error), self.abort()),
        }
    }
    pub(super) fn finish(mut self) -> Result<()> {
        let guard = self.gate.guard(None).map(|_| ());
        self.finished = true;
        finalized(guard, self.cleanup())
    }
    pub(super) fn finish_claim(mut self, claim: &super::claim::TerminalClaim) -> Result<()> {
        let terminal = self.gate.finish_claim(claim);
        self.finished = true;
        finalized(terminal, self.cleanup())
    }
    pub(super) fn finish_preparation(
        mut self,
        claim: &super::preparation::RetainedPreparation,
        phase: super::preparation_phase::PublicationPhase,
    ) -> Result<()> {
        let terminal = self.gate.finish_preparation(claim, phase);
        self.finished = true;
        finalized(terminal, self.cleanup())
    }
    fn abort(mut self) -> Result<()> {
        self.finished = true;
        self.cleanup()
    }
    fn cleanup(&self) -> Result<()> {
        let closed = close_active(&self.active);
        let released = match self.gate.state.lock() {
            Ok(mut state) => need(
                state
                    .active
                    .as_ref()
                    .is_some_and(|active| Arc::ptr_eq(active, &self.active)),
                "RESERVATION_ADMISSION_LOCK_REQUIRED",
            )
            .map(|()| state.active = None),
            Err(poison) => {
                let mut state = poison.into_inner();
                if state
                    .active
                    .as_ref()
                    .is_some_and(|active| Arc::ptr_eq(active, &self.active))
                {
                    state.active = None;
                }
                Err(GateError::Refused("RESERVATION_ADMISSION_UNAVAILABLE"))
            }
        };
        self.gate.changed.notify_all();
        finalized(closed, released)
    }
}
impl Entry {
    fn activate(mut self, active: Arc<Active>) -> Result<Admission> {
        let published = (|| {
            let mut state = self
                .gate
                .state
                .lock()
                .map_err(|_| GateError::Refused("RESERVATION_ADMISSION_UNAVAILABLE"))?;
            need(
                state.active.is_none()
                    && state
                        .entering
                        .as_ref()
                        .is_some_and(|entry| Arc::ptr_eq(&entry.token, &self.token)),
                "RESERVATION_ADMISSION_LOCK_REQUIRED",
            )?;
            state.entering = None;
            state.active = Some(active.clone());
            Ok(())
        })();
        if let Err(error) = published {
            return finalized(Err(error), finalized(close_active(&active), self.cancel()));
        }
        self.finished = true;
        Ok(Admission {
            gate: self.gate.clone(),
            active,
            finished: false,
            _thread: std::marker::PhantomData,
        })
    }
    pub(super) fn cancel(mut self) -> Result<()> {
        self.finished = true;
        self.release()
    }
    fn release(&self) -> Result<()> {
        let (mut state, poisoned) = match self.gate.state.lock() {
            Ok(state) => (state, false),
            Err(poison) => (poison.into_inner(), true),
        };
        let owned = state
            .entering
            .as_ref()
            .is_some_and(|entry| Arc::ptr_eq(&entry.token, &self.token));
        if owned {
            state.entering = None;
        }
        let result = need(!poisoned, "RESERVATION_ADMISSION_UNAVAILABLE")
            .and_then(|()| need(owned, "RESERVATION_ADMISSION_LOCK_REQUIRED"));
        drop(state);
        self.gate.changed.notify_all();
        result
    }
}
impl Drop for Entry {
    fn drop(&mut self) {
        if !self.finished {
            let _ = self.release();
        }
    }
}
fn close_active(active: &Active) -> Result<()> {
    match active.lock.lock() {
        Ok(mut lock) => lock.close().map_err(Into::into),
        Err(poison) => finalized(
            Err(GateError::Refused("RESERVATION_ADMISSION_UNAVAILABLE")),
            poison.into_inner().close().map_err(Into::into),
        ),
    }
}
impl Drop for Admission {
    fn drop(&mut self) {
        // Abandonment releases only owned descriptors/local waiting state; it
        // produces no success acknowledgement, credit, or completed boundary.
        if !self.finished {
            let _ = self.cleanup();
        }
    }
}
