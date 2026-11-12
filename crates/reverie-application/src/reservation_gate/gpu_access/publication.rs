use super::*;
use reverie_contracts::gpu_access::GpuTransitionIntent;
use reverie_host::{
    gpu_access::{
        CdiObservation, GpuActorPublication, GpuActorPublicationInput, GpuParentGuard,
        GpuPendingFile, GpuProtectedStores,
    },
    resource_facts::ActorRebindPlan,
    worker_runtime::WorkerStopBudget,
};
pub(super) struct OriginalPublication {
    pub(super) configuration: GpuFileStamp,
    pub(super) binding: GpuFileStamp,
    pub(super) request: Option<GpuFileStamp>,
    pub(super) parents: GpuParentGuard,
    pub(super) protected: GpuProtectedStores,
    pub(super) cdi: Option<CdiObservation>,
    pub(super) current: GpuCurrentEmployee,
}
enum Pending {
    NotSubmitted,
    Attempted,
    Owned(Box<GpuPendingFile>),
}
/// Actual same-admission file producer state, never constructible from JSON or
/// a historical receipt. Failed records remain with the Gate and block entry.
pub(in crate::reservation_gate) struct TransitionRecord {
    pub(super) rows: Arc<ObservedInventory>,
    pub(super) files: GpuControlFiles,
    pub(super) intent: Arc<GpuTransitionIntent>,
    pub(super) before: Arc<ValidatedWorkerSnapshot>,
    pub(super) after: Arc<ValidatedWorkerSnapshot>,
    pub(super) original: OriginalPublication,
    actor: Option<ActorRebindPlan>,
    publication: Mutex<Option<Arc<GpuActorPublication>>>,
    pending: Mutex<Pending>,
}
pub(crate) struct PublishedGpu {
    record: Arc<TransitionRecord>,
    before: Arc<ValidatedWorkerSnapshot>,
    after: Arc<ValidatedWorkerSnapshot>,
    binding: ControlBinding,
    actor: Option<Arc<GpuActorPublication>>,
}
impl PublishedGpu {
    pub(crate) fn parts(
        &self,
    ) -> (
        &Arc<ValidatedWorkerSnapshot>,
        &Arc<ValidatedWorkerSnapshot>,
        &ControlBinding,
    ) {
        (&self.before, &self.after, &self.binding)
    }
    pub(crate) fn assert_live(&self) -> Result<()> {
        if let Some(actor) = &self.actor {
            actor.assert_live()?;
        }
        Ok(())
    }
    pub(super) fn belongs_to(&self, record: &Arc<TransitionRecord>) -> bool {
        Arc::ptr_eq(&self.record, record)
    }
}
impl TransitionRecord {
    pub(super) fn new(
        files: GpuControlFiles,
        rows: Arc<ObservedInventory>,
        intent: GpuTransitionIntent,
        before: Arc<ValidatedWorkerSnapshot>,
        after: Arc<ValidatedWorkerSnapshot>,
        actor: Option<ActorRebindPlan>,
        original: OriginalPublication,
    ) -> Self {
        Self {
            files,
            rows,
            intent: Arc::new(intent),
            before,
            after,
            original,
            actor,
            publication: Mutex::new(None),
            pending: Mutex::new(Pending::NotSubmitted),
        }
    }
    pub(super) fn publish_pending(
        &self,
        end: Instant,
        active: &Active,
        stop: Option<&WorkerStopBudget>,
    ) -> Result<()> {
        let mut state = self
            .pending
            .lock()
            .map_err(|_| GateError::Refused("GPU_APPLY_REQUIRES_RECONCILIATION"))?;
        need(
            matches!(*state, Pending::NotSubmitted),
            "GPU_APPLY_REQUIRES_RECONCILIATION",
        )?;
        *state = Pending::Attempted;
        let file = match (&self.actor, stop) {
            (Some(_), Some(stop)) => {
                let admission = active
                    .lock
                    .lock()
                    .map_err(|_| GateError::Refused("RESERVATION_ADMISSION_UNAVAILABLE"))?;
                let request = self
                    .original
                    .request
                    .as_ref()
                    .ok_or(GateError::Refused("GPU_REQUEST_CHANGED"))?;
                self.files.publish_pending_with_actor(
                    self.intent.clone(),
                    end,
                    &admission,
                    stop,
                    request,
                )?
            }
            (None, None) => self.files.publish_pending(self.intent.clone(), end)?,
            _ => return Err(GateError::Refused("GPU_ACTOR_PUBLICATION_CHANGED")),
        };
        *state = Pending::Owned(Box::new(file));
        if let (Some(_), Pending::Owned(pending)) = (&self.actor, &*state) {
            pending.assert_current(&self.files)?;
        }
        Ok(())
    }
    pub(in crate::reservation_gate) fn assert_pending(&self) -> Result<()> {
        let pending = self
            .pending
            .lock()
            .map_err(|_| GateError::Refused("GPU_APPLY_REQUIRES_RECONCILIATION"))?;
        let Pending::Owned(pending) = &*pending else {
            return Err(GateError::Refused("GPU_TRANSITION_PENDING_CHANGED"));
        };
        Ok(pending.assert_current(&self.files)?)
    }
    /// The sealed GPU handoff follows all applicable fixed CAS writes and
    /// their checked finalizers.
    pub(super) fn publish_files(self: &Arc<Self>, active: &Active) -> Result<PublishedGpu> {
        let actor = match &self.actor {
            Some(plan) => Some(self.publish_actor(plan, active)?),
            None => {
                self.publish_legacy()?;
                None
            }
        };
        Ok(PublishedGpu {
            record: self.clone(),
            before: self.before.clone(),
            after: self.after.clone(),
            binding: self.intent.after_binding().clone(),
            actor,
        })
    }
    fn publish_legacy(self: &Arc<Self>) -> Result<()> {
        self.files
            .publish_configuration(&self.intent, &self.original.configuration)?;
        #[cfg(test)]
        super::tests::faults::at(super::tests::faults::Point::ConfigWritten, self)?;
        self.files
            .publish_binding(&self.intent, &self.original.binding)?;
        Ok(())
    }
    fn publish_actor(
        &self,
        actor: &ActorRebindPlan,
        active: &Active,
    ) -> Result<Arc<GpuActorPublication>> {
        let mut output = self
            .publication
            .lock()
            .map_err(|_| GateError::Refused("GPU_APPLY_REQUIRES_RECONCILIATION"))?;
        need(output.is_none(), "GPU_ACTOR_PUBLICATION_CHANGED")?;
        let admission = active
            .lock
            .lock()
            .map_err(|_| GateError::Refused("RESERVATION_ADMISSION_UNAVAILABLE"))?;
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| GateError::Refused("GPU_APPLY_REQUIRES_RECONCILIATION"))?;
        let Pending::Owned(pending) = &mut *pending else {
            return Err(GateError::Refused("GPU_TRANSITION_PENDING_CHANGED"));
        };
        let actual = pending.publish_with_actor(
            &self.files,
            GpuActorPublicationInput {
                configuration: &self.original.configuration,
                binding: &self.original.binding,
                actor,
                admission: &admission,
                cdi: self.original.cdi.as_ref(),
            },
        )?;
        let actual = Arc::new(actual);
        *output = Some(Arc::clone(&actual));
        Ok(actual)
    }
    pub(super) fn actor_publication(&self) -> Result<Arc<GpuActorPublication>> {
        self.publication
            .lock()
            .map_err(|_| GateError::Refused("GPU_APPLY_REQUIRES_RECONCILIATION"))?
            .as_ref()
            .map(Arc::clone)
            .ok_or(GateError::Refused("GPU_ACTOR_PUBLICATION_REQUIRED"))
    }
    pub(super) fn terminal(&self) -> Result<reverie_host::gpu_access::GpuTerminalSnapshot> {
        let pending = self
            .pending
            .lock()
            .map_err(|_| GateError::Refused("GPU_APPLY_REQUIRES_RECONCILIATION"))?;
        let Pending::Owned(pending) = &*pending else {
            return Err(GateError::Refused("GPU_TRANSITION_PENDING_CHANGED"));
        };
        Ok(self.files.capture_terminal(
            self.original.request.as_ref(),
            pending,
            &self.original.protected,
            self.original.cdi.as_ref(),
        )?)
    }
    pub(super) fn release(&self) -> Result<()> {
        let actor = self
            .actor
            .as_ref()
            .map(|_| self.actor_publication())
            .transpose()?;
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| GateError::Refused("GPU_APPLY_REQUIRES_RECONCILIATION"))?;
        let Pending::Owned(pending) = &mut *pending else {
            return Err(GateError::Refused("GPU_TRANSITION_PENDING_CHANGED"));
        };
        match actor {
            Some(actor) => Ok(pending.release_with_actor(&actor)?),
            None => Ok(pending.release()?),
        }
    }
}
impl Inner {
    pub(in crate::reservation_gate) fn assert_no_failed_gpu(&self) -> Result<()> {
        let failed = self
            .failed_gpu
            .lock()
            .map_err(|_| GateError::Refused("GPU_APPLY_REQUIRES_RECONCILIATION"))?;
        need(failed.is_empty(), "GPU_APPLY_REQUIRES_RECONCILIATION")
    }
    pub(super) fn retain_failed_gpu(&self, record: &Arc<TransitionRecord>) {
        // A prior retained record prevents every later admission/constructor.
        // Taking a poisoned guard retains evidence; it never repairs the lock.
        let mut failed = self
            .failed_gpu
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if !failed.iter().any(|saved| Arc::ptr_eq(saved, record)) {
            failed.push(record.clone());
        }
    }
    pub(super) fn publish_gpu(
        &self,
        proof: PublishedGpu,
        lifecycle: &crate::installing_broker::LaptopLifecycle<'_>,
    ) -> Result<()> {
        let active = self.held(None)?;
        let state = self
            .state
            .lock()
            .map_err(|_| GateError::Refused("RESERVATION_ADMISSION_UNAVAILABLE"))?;
        need(
            state
                .active
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, &active)),
            "RESERVATION_ADMISSION_LOCK_REQUIRED",
        )?;
        let transition = active
            .gpu_transition
            .lock()
            .map_err(|_| GateError::Refused("GPU_APPLY_REQUIRES_RECONCILIATION"))?;
        need(
            transition
                .as_ref()
                .is_some_and(|record| proof.belongs_to(record)),
            "GPU_TRANSITION_PENDING_CHANGED",
        )?;
        let mut context = active
            .context
            .lock()
            .map_err(|_| GateError::Refused("RESERVATION_ADMISSION_UNAVAILABLE"))?;
        self.installed
            .publish_gpu(proof, lifecycle, &mut context, &self.binding)
    }
    pub(in crate::reservation_gate) fn gpu_pending_current(
        &self,
        active: &Arc<Active>,
    ) -> Result<()> {
        let record = active
            .gpu_transition
            .lock()
            .map_err(|_| GateError::Refused("GPU_APPLY_REQUIRES_RECONCILIATION"))?;
        record
            .as_ref()
            .ok_or(GateError::Refused(
                "RESERVATION_INSTALL_REQUIRES_RECONCILIATION",
            ))?
            .assert_pending()
    }
    pub(in crate::reservation_gate) fn gpu_rows_current(
        &self,
        active: &Arc<Active>,
        rows: &ObservedInventory,
    ) -> Result<()> {
        let record = active
            .gpu_transition
            .lock()
            .map_err(|_| GateError::Refused("GPU_APPLY_REQUIRES_RECONCILIATION"))?;
        if let Some(record) = record.as_ref() {
            need(record.rows.equivalent(rows), "GPU_NATIVE_CHANGED")?;
        }
        Ok(())
    }
}
