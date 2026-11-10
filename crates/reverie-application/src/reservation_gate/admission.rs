use super::*;
use std::time::Duration;
mod contention;
mod fleet_cleanup;
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
    ram_journal: Option<super::ram_journal::SharedJournal>,
    _thread: std::marker::PhantomData<std::rc::Rc<()>>,
}
enum CleanupPurpose {
    Abort,
    BoundaryClosed,
}
pub(super) struct Entering {
    thread: ThreadId,
    process: u32,
    token: Arc<()>,
}
pub(super) struct Entry {
    gate: Arc<Inner>,
    token: Arc<()>,
    original_cleanup: Option<pool_transition::OriginalCleanupAdmission>,
    finished: bool,
    _thread: std::marker::PhantomData<std::rc::Rc<()>>,
}
impl Inner {
    pub(super) fn admit(self: &Arc<Self>, bounds: AdmissionBounds) -> Result<Admission> {
        self.admit_selected(bounds, None, None)
    }
    pub(super) fn admit_launch(
        self: &Arc<Self>,
        bounds: AdmissionBounds,
        session: &reverie_core::ids::ProfileSessionId,
    ) -> Result<Admission> {
        self.admit_selected(bounds, Some(session), None)
    }
    /// Broker.stop has no launch/entry body budget. Its real first-stop ceiling
    /// bounds native observation without changing admission mutex/flock order.
    pub(super) fn admit_stop(
        self: &Arc<Self>,
        budget: Option<&reverie_host::worker_runtime::WorkerStopBudget>,
    ) -> Result<Admission> {
        self.admit_selected(AdmissionBounds::default(), None, budget)
    }
    pub(super) fn admit_original_cleanup(
        self: &Arc<Self>,
        cleanup: pool_transition::OriginalCleanupAdmission,
        budget: &reverie_host::worker_runtime::WorkerStopBudget,
    ) -> Result<Admission> {
        let entry = self.reserve_selected_entry(None, Some(cleanup))?;
        self.enter_reserved(AdmissionBounds::default(), None, None, Some(budget), entry)
    }
    fn admit_selected(
        self: &Arc<Self>,
        bounds: AdmissionBounds,
        ordinary_session: Option<&reverie_core::ids::ProfileSessionId>,
        native_budget: Option<&reverie_host::worker_runtime::WorkerStopBudget>,
    ) -> Result<Admission> {
        let end = bounds.validate()?;
        let entry = self.reserve_entry(end)?;
        self.enter_reserved(bounds, end, ordinary_session, native_budget, entry)
    }
    pub(super) fn admit_ready_stop(
        self: &Arc<Self>,
        end: Instant,
        budget: &reverie_host::worker_runtime::WorkerStopBudget,
    ) -> Result<Option<Admission>> {
        let bounds = AdmissionBounds {
            operation: Some(end),
            entry: Some(end),
        };
        let end = bounds.validate()?;
        self.assert_no_pool_transition()?;
        let mut state = match self.state.try_lock() {
            Ok(state) => state,
            Err(std::sync::TryLockError::WouldBlock) => return Ok(None),
            Err(_) => return Err(GateError::Refused("RESERVATION_ADMISSION_UNAVAILABLE")),
        };
        if state.active.is_some() || state.entering.is_some() {
            return Ok(None);
        }
        self.assert_no_pool_transition()?;
        let token = Arc::new(());
        state.entering = Some(Entering {
            thread: std::thread::current().id(),
            process: std::process::id(),
            token: token.clone(),
        });
        drop(state);
        let entry = Entry {
            gate: self.clone(),
            token,
            original_cleanup: None,
            finished: false,
            _thread: std::marker::PhantomData,
        };
        self.enter_reserved(bounds, end, None, Some(budget), entry)
            .map(Some)
    }
    fn enter_reserved(
        self: &Arc<Self>,
        bounds: AdmissionBounds,
        end: Option<Instant>,
        ordinary_session: Option<&reverie_core::ids::ProfileSessionId>,
        native_budget: Option<&reverie_host::worker_runtime::WorkerStopBudget>,
        entry: Entry,
    ) -> Result<Admission> {
        // Never hold the waiting-state mutex across filesystem I/O. Another
        // thread's bounded wait must remain bounded while this open stalls.
        let config = match self.config() {
            Ok(config) => config,
            Err(error) => return finalized(Err(error), entry.cancel()),
        };
        let acquired = if let (None, Some(end)) = (native_budget, end) {
            self.acquire_contended_entry(&config, end)
        } else {
            AdmissionLock::acquire(&config).map_err(GateError::from)
        };
        let lock = match acquired {
            Ok(lock) => lock,
            Err(error) => return finalized(Err(error), entry.cancel()),
        };
        let active = Arc::new(Active {
            thread: std::thread::current().id(),
            process: std::process::id(),
            lock: Mutex::new(lock),
            context: Mutex::new(self.observer.capture(config.configuration().clone(), None)),
            deadline: Mutex::new(end),
            policy_ack: Mutex::new(None),
            gpu_transition: Mutex::new(None),
            image_transition: Mutex::new(None),
            ram_authority: Mutex::new(None),
            original_cleanup: entry.original_cleanup.clone(),
        });
        #[cfg(test)]
        {
            let pause = self.entry_capture_pause.lock().unwrap().take();
            if let Some(pause) = pause {
                let captured = active.context.lock().unwrap().with_inherited(end);
                pause.wait(captured);
            }
        }
        let admission = entry.activate(active)?;
        let entered = (|| {
            if let Some(budget) = native_budget {
                admission
                    .active
                    .context
                    .lock()
                    .map_err(|_| GateError::Refused("RESERVATION_ADMISSION_UNAVAILABLE"))?
                    .inherit_worker_stop_budget(budget)?;
            }
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
        self.reserve_selected_entry(end, None)
    }
    fn reserve_selected_entry(
        self: &Arc<Self>,
        end: Option<Instant>,
        original_cleanup: Option<pool_transition::OriginalCleanupAdmission>,
    ) -> Result<Entry> {
        self.assert_entry_purpose(original_cleanup.as_ref())?;
        self.assert_no_failed_image()?;
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
            #[cfg(test)]
            if let Some(notice) = self.entry_wait_notice.lock().unwrap().take() {
                // Observe the actual contended branch, without replacing a
                // result, deadline, lock owner or wakeup.
                let _ = notice.try_send(());
            }
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
        self.assert_entry_purpose(original_cleanup.as_ref())?;
        self.assert_no_failed_image()?;
        let token = Arc::new(());
        state.entering = Some(Entering {
            thread: std::thread::current().id(),
            process: std::process::id(),
            token: token.clone(),
        });
        Ok(Entry {
            gate: self.clone(),
            token,
            original_cleanup,
            finished: false,
            _thread: std::marker::PhantomData,
        })
    }
}
impl Admission {
    pub(super) fn finish_image(
        self,
        record: &Arc<super::image_switch::ImageTransitionRecord>,
    ) -> Result<()> {
        if !Arc::ptr_eq(&self.active, &record.active) {
            return finalized(
                Err(GateError::Refused("WORKER_IMAGE_ADMISSION_CHANGED")),
                self.abort(),
            );
        }
        self.finish()?;
        record.admission_closed()
    }
    pub(super) fn retain_ram_journal(
        &mut self,
        claim: &RetainedPreparation,
        journal: super::ram_journal::SharedJournal,
    ) -> Result<()> {
        need(
            self.ram_journal.is_none()
                && Arc::ptr_eq(&self.gate, &claim.gate)
                && claim
                    .ram_journal
                    .as_ref()
                    .is_some_and(|own| Arc::ptr_eq(own, &journal))
                && claim.ram_authority.as_ref().is_some_and(|authority| {
                    self.active.ram_authority.lock().is_ok_and(|selected| {
                        selected
                            .as_ref()
                            .is_some_and(|own| Weak::ptr_eq(own, &Arc::downgrade(authority)))
                    })
                }),
            "RAM_JOURNAL_ADMISSION_CHANGED",
        )?;
        self.ram_journal = Some(journal);
        Ok(())
    }
    pub(super) fn bind_ram_authority(
        &self,
        authority: &Arc<super::ram_authority::RamJournalAuthority>,
    ) -> Result<()> {
        let active = self.gate.held(None)?;
        need(
            Arc::ptr_eq(&active, &self.active),
            "RESERVATION_ADMISSION_LOCK_REQUIRED",
        )?;
        let mut selected = self
            .active
            .ram_authority
            .lock()
            .map_err(|_| GateError::Refused("RESOURCE_RAM_JOURNAL_UNAVAILABLE"))?;
        need(selected.is_none(), "RESOURCE_RAM_JOURNAL_SCOPE_RETAINED")?;
        authority.bind(&self.gate, &self.active)?;
        *selected = Some(Arc::downgrade(authority));
        Ok(())
    }
    fn revoke_ram_authority(&self) -> Result<()> {
        let selected = self
            .active
            .ram_authority
            .lock()
            .map_err(|_| GateError::Refused("RESOURCE_RAM_JOURNAL_UNAVAILABLE"))?
            .take();
        match selected {
            Some(weak) => weak
                .upgrade()
                .ok_or(GateError::Refused("RESOURCE_RAM_JOURNAL_PURPOSE_CHANGED"))?
                .revoke(&self.active),
            None => Ok(()),
        }
    }
    /// Python's context-manager body exception skips success/terminal native
    /// work and proceeds directly to mandatory owned cleanup.
    pub(super) fn conclude<T>(self, result: Result<T>) -> Result<T> {
        match result {
            Ok(value) => finalized(Ok(value), self.finish()),
            Err(error) => finalized(Err(error), self.abort()),
        }
    }
    fn suspend_ram_journal(&self) -> Result<()> {
        self.ram_journal.as_ref().map_or(Ok(()), |journal| {
            journal
                .try_lock()
                .map_err(|_| GateError::Refused("RAM_JOURNAL_UNAVAILABLE"))?
                .suspend()
        })
    }
    fn quarantine_ram_journal(&self) -> Result<()> {
        self.ram_journal.as_ref().map_or(Ok(()), |journal| {
            journal
                .try_lock()
                .map_err(|_| GateError::Refused("RAM_JOURNAL_UNAVAILABLE"))?
                .quarantine()
        })
    }
    fn finish_result<T>(mut self, result: Result<T>) -> Result<T> {
        let purpose = if result.is_ok() {
            CleanupPurpose::BoundaryClosed
        } else {
            CleanupPurpose::Abort
        };
        self.finished = true;
        finalized(result, self.cleanup(purpose))
    }
    pub(super) fn finish(self) -> Result<()> {
        let guard = self
            .suspend_ram_journal()
            .and_then(|()| self.gate.guard(None).map(|_| ()));
        self.finish_result(guard)
    }
    pub(super) fn finish_claim(self, claim: &super::claim::TerminalClaim) -> Result<()> {
        let terminal = self
            .suspend_ram_journal()
            .and_then(|()| self.gate.finish_claim(claim));
        self.finish_result(terminal)
    }
    pub(super) fn finish_preparation(
        self,
        claim: &super::preparation::RetainedPreparation,
        phase: super::preparation_phase::PublicationPhase,
    ) -> Result<()> {
        let terminal = self
            .suspend_ram_journal()
            .and_then(|()| self.gate.finish_preparation(claim, phase));
        self.finish_result(terminal)
    }
    pub(super) fn abort(mut self) -> Result<()> {
        self.finished = true;
        self.cleanup(CleanupPurpose::Abort)
    }
    pub(super) fn finish_native_start(
        self,
        claim: &super::preparation::RetainedPreparation,
        intent: &super::preparation_start::ProtectedStartIntent,
    ) -> Result<()> {
        self.native_start_boundary(claim, intent, true).map(|_| ())
    }
    pub(super) fn inspect_native_start(
        self,
        claim: &super::preparation::RetainedPreparation,
        intent: &super::preparation_start::ProtectedStartIntent,
    ) -> Result<super::preparation_start::StartQualificationFacts> {
        self.native_start_boundary(claim, intent, false)
    }
    fn native_start_boundary(
        self,
        claim: &super::preparation::RetainedPreparation,
        intent: &super::preparation_start::ProtectedStartIntent,
        allow_running: bool,
    ) -> Result<super::preparation_start::StartQualificationFacts> {
        let result = if Arc::ptr_eq(&self.gate, &claim.gate) {
            self.suspend_ram_journal()
                .and_then(|()| claim.qualify_intent(intent, allow_running))
        } else {
            Err(GateError::Refused("RESOURCE_NATIVE_PERMIT_REQUIRED"))
        };
        self.finish_result(result)
    }
    fn cleanup(&self, purpose: CleanupPurpose) -> Result<()> {
        // No journal validation/native observation follows a terminal stamp
        // or a body error. Abort custody moves into a non-resumable facade.
        let quarantined = match purpose {
            CleanupPurpose::Abort => self.quarantine_ram_journal(),
            CleanupPurpose::BoundaryClosed => Ok(()),
        };
        // Revoke this exact journal purpose before any fallible native close.
        // Escaped store guards cannot borrow the next admission's authority.
        let revoked = self.revoke_ram_authority();
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
        let result = finalized(quarantined, finalized(revoked, finalized(closed, released)));
        if result.is_err() {
            finalized(result, self.quarantine_ram_journal())
        } else {
            result
        }
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
            // A real image-only loader may publish while this entry is opening
            // its already selected native lock. Synchronize only that exact
            // Python-equality projection; never copy arbitrary newer policy.
            let current = self.gate.installed.snapshot()?;
            let mut context = active
                .context
                .lock()
                .map_err(|_| GateError::Refused("RESERVATION_ADMISSION_UNAVAILABLE"))?;
            need(
                reverie_contracts::worker_config::image_only_equivalent(
                    context.configuration(),
                    current.configuration(),
                ),
                "WORKER_ENTRY_CONFIGURATION_CHANGED",
            )?;
            *context = context.with_applied_configuration(current.configuration().clone());
            drop(context);
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
            ram_journal: None,
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
            let _ = self.cleanup(CleanupPurpose::Abort);
        }
    }
}
