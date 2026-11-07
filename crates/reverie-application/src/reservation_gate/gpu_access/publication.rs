use super::*;
use reverie_contracts::gpu_access::GpuTransitionIntent;
use reverie_host::gpu_access::GpuPendingFile;
enum Pending {
    NotSubmitted,
    Attempted,
    Owned(GpuPendingFile),
}
/// Actual same-admission file producer state, never constructible from JSON or
/// a historical receipt. Failed records remain with the Gate and block entry.
pub(in crate::reservation_gate) struct TransitionRecord {
    pub(super) rows: Arc<ObservedInventory>,
    pub(super) files: GpuControlFiles,
    pub(super) intent: Arc<GpuTransitionIntent>,
    pub(super) before: Arc<ValidatedWorkerSnapshot>,
    after: Arc<ValidatedWorkerSnapshot>,
    pending: Mutex<Pending>,
}
pub(crate) struct PublishedGpu {
    record: Arc<TransitionRecord>,
    before: Arc<ValidatedWorkerSnapshot>,
    after: Arc<ValidatedWorkerSnapshot>,
    binding: ControlBinding,
}
impl PublishedGpu {
    pub(crate) fn into_parts(
        self,
    ) -> (
        Arc<ValidatedWorkerSnapshot>,
        Arc<ValidatedWorkerSnapshot>,
        ControlBinding,
    ) {
        (self.before, self.after, self.binding)
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
    ) -> Self {
        Self {
            files,
            rows,
            intent: Arc::new(intent),
            before,
            after,
            pending: Mutex::new(Pending::NotSubmitted),
        }
    }
    pub(super) fn publish_pending(&self, end: Instant) -> Result<()> {
        let mut state = self
            .pending
            .lock()
            .map_err(|_| GateError::Refused("GPU_APPLY_REQUIRES_RECONCILIATION"))?;
        need(
            matches!(*state, Pending::NotSubmitted),
            "GPU_APPLY_REQUIRES_RECONCILIATION",
        )?;
        *state = Pending::Attempted;
        let file = self.files.publish_pending(self.intent.clone(), end)?;
        *state = Pending::Owned(file);
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
    /// The sealed RAM handoff exists only after BOTH actual fixed CAS writers
    /// and their checked finalizers acknowledge success. No data-only factory.
    pub(super) fn publish_files(
        self: &Arc<Self>,
        config: &GpuFileStamp,
        binding: &GpuFileStamp,
    ) -> Result<PublishedGpu> {
        self.files.publish_configuration(&self.intent, config)?;
        #[cfg(test)]
        super::tests::faults::at(super::tests::faults::Point::ConfigWritten, self)?;
        self.files.publish_binding(&self.intent, binding)?;
        Ok(PublishedGpu {
            record: self.clone(),
            before: self.before.clone(),
            after: self.after.clone(),
            binding: self.intent.after_binding().clone(),
        })
    }
    pub(super) fn terminal(
        &self,
        request: Option<&GpuFileStamp>,
        protected: &reverie_host::gpu_access::GpuProtectedStores,
        cdi: Option<&reverie_host::gpu_access::CdiObservation>,
    ) -> Result<reverie_host::gpu_access::GpuTerminalSnapshot> {
        let pending = self
            .pending
            .lock()
            .map_err(|_| GateError::Refused("GPU_APPLY_REQUIRES_RECONCILIATION"))?;
        let Pending::Owned(pending) = &*pending else {
            return Err(GateError::Refused("GPU_TRANSITION_PENDING_CHANGED"));
        };
        Ok(self
            .files
            .capture_terminal(request, pending, protected, cdi)?)
    }
    pub(super) fn release(&self) -> Result<()> {
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| GateError::Refused("GPU_APPLY_REQUIRES_RECONCILIATION"))?;
        let Pending::Owned(pending) = &mut *pending else {
            return Err(GateError::Refused("GPU_TRANSITION_PENDING_CHANGED"));
        };
        Ok(pending.release()?)
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
