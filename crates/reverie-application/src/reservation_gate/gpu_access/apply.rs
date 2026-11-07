use super::*;
use reverie_contracts::gpu_access::{GpuCandidate, GpuTransitionIntent};
use reverie_host::gpu_access::{
    CdiObservation, GpuParentGuard, GpuProtectedStores, GpuTerminalSnapshot,
};
use reverie_store::storage_identity::{self, StorageIdentityConfig};
struct Ready {
    before: Arc<ValidatedWorkerSnapshot>,
    after: Arc<ValidatedWorkerSnapshot>,
    current: GpuCurrentEmployee,
    files: GpuControlFiles,
    config_stamp: GpuFileStamp,
    binding_stamp: GpuFileStamp,
    request_stamp: Option<GpuFileStamp>,
    rows: Arc<ObservedInventory>,
    intent: GpuTransitionIntent,
    protected: GpuProtectedStores,
    cdi: Option<CdiObservation>,
}
struct Ending {
    record: Arc<TransitionRecord>,
    terminal: GpuTerminalSnapshot,
    parents: GpuParentGuard,
    current: GpuCurrentEmployee,
}
struct Enabled {
    physical: reverie_core::gpu_access::PhysicalGpu,
    info: gpu_access::GpuEngineInformation,
    cdi: CdiObservation,
}
impl<P: Platform> Service<'_, P> {
    pub(super) fn apply(
        &self,
        employee: &JournalId,
        expected: &GpuQueuedRequest,
        end: Instant,
    ) -> Result<()> {
        let mut retained = None;
        let result = self.apply_attempt(employee, expected, end, &mut retained);
        match (result, retained) {
            (Err(cause), Some(record)) => {
                self.gate.inner.retain_failed_gpu(&record);
                Err(GateError::GpuApplyUncertain {
                    cause: Box::new(cause),
                })
            }
            (result, _) => result,
        }
    }
    fn apply_attempt(
        &self,
        employee: &JournalId,
        expected: &GpuQueuedRequest,
        end: Instant,
        retained: &mut Option<Arc<TransitionRecord>>,
    ) -> Result<()> {
        let admission = self.gate.inner.admit(Self::bounds(end))?;
        let lifecycle = match self.gate.inner.installed.gpu_lifecycle(end) {
            Ok(lifecycle) => lifecycle,
            Err(error) => return admission.conclude(Err(error)),
        };
        let ready = self.prepare(employee, expected, end);
        let result = ready.and_then(|ready| match ready {
            None => Ok(None),
            Some(ready) => self.commit(ready, end, &lifecycle, retained).map(Some),
        });
        let ending = admission.conclude(result)?;
        let Some(ending) = ending else {
            return Ok(());
        };
        #[cfg(test)]
        super::tests::faults::at(super::tests::faults::Point::AdmissionClosed, &ending.record)?;
        ending.terminal.assert_current()?;
        let current =
            reverie_host::gpu_access::current_employee(ending.record.intent.after(), employee)?;
        need(
            current.data() == ending.current.data(),
            "GPU_TERMINAL_CAS_CHANGED",
        )?;
        ending.parents.assert_current()?;
        ending.terminal.assert_current()?;
        #[cfg(test)]
        super::tests::faults::at(super::tests::faults::Point::BeforeRelease, &ending.record)?;
        ending.record.release()?;
        Ok(())
    }
    fn prepare(
        &self,
        employee: &JournalId,
        expected: &GpuQueuedRequest,
        end: Instant,
    ) -> Result<Option<Ready>> {
        let before = self.gate.inner.installed.snapshot()?;
        let config = before.configuration();
        let files = self.files(config)?;
        let config_stamp = self.private_current(&files, config)?;
        let current = reverie_host::gpu_access::current_employee(config, employee)?;
        let (requests, request_stamp) = self.requests(&files)?;
        let request = requests.requests().get(employee);
        need(request == Some(expected), "GPU_REQUEST_CHANGED")?;
        let binding = self.binding(config, &current)?;
        need(expected.matches_binding(&binding), "GPU_STALE_REQUEST")?;
        let rows = Arc::new(self.gate.inner.guard(None)?);
        let selected = rows.gpu_selected(config, current.data())?;
        let context = self.gate.inner.native_context()?;
        need(
            context
                .custody_gpu_source(&before, Some(end))?
                .equivalent(&rows),
            "GPU_NATIVE_CHANGED",
        )?;
        if selected
            .as_ref()
            .is_some_and(|row| row.data().running() == Ok(true))
        {
            return Ok(None);
        }
        let applied = gpu_access::applied(config, current.data())?;
        if expected.device() == applied.device() {
            return Ok(None);
        }
        if self.platform.installed_consumers(config)? {
            return Ok(None);
        }
        self.idle(&files)?;
        self.gate.inner.check_headroom()?;
        let candidate = GpuCandidate::project(config, employee, expected.device())?;
        let enabled = expected
            .device()
            .map(|device| self.enable(device, end))
            .transpose()?;
        need(
            gpu_access::applied(candidate.after(), current.data())?.device() == expected.device(),
            "GPU_LEGACY_SESSION_OVERRIDE",
        )?;
        let after = Arc::new(before.validate_gpu_candidate(&candidate)?);
        self.check_peers(&candidate, current.data().session())?;
        let old_binding = files.read_binding()?;
        let (_, bound) = self
            .gate
            .inner
            .installed
            .bound_resources(&self.gate.inner.binding)?;
        need(
            bound.matches_metadata(old_binding.metadata()),
            "GPU_CONTROL_BINDING_CHANGED",
        )?;
        let protected = files.protected_stores()?;
        let cdi = match (expected.device(), enabled) {
            (Some(device), Some(enabled)) => Some(self.recheck_enabled(device, enabled, end)?),
            _ => None,
        };
        need(
            context.inventory(Some(end))?.equivalent(&rows)
                && self.gate.inner.guard(None)?.equivalent(&rows),
            "GPU_NATIVE_CHANGED",
        )?;
        let latest = reverie_host::gpu_access::current_employee(config, employee)?;
        need(
            latest.data() == current.data()
                && self.private_current(&files, config)? == config_stamp
                && self.requests(&files)?.1 == request_stamp,
            "GPU_APPLY_CAS_CHANGED",
        )?;
        let intent = GpuTransitionIntent::capture(&candidate, employee, expected, &bound)?;
        Ok(Some(Ready {
            before,
            after,
            current,
            files,
            config_stamp,
            binding_stamp: old_binding.stamp().clone(),
            request_stamp,
            rows,
            intent,
            protected,
            cdi,
        }))
    }
    fn idle(&self, files: &GpuControlFiles) -> Result<()> {
        self.gate.inner.require_host_job_idle()?;
        need(
            self.gate.inner.document()?.operations().is_empty(),
            "GPU_RESOURCE_OPERATION_REQUIRES_RECONCILIATION",
        )?;
        need(
            !files.host_history_present()?,
            "GPU_HOST_HISTORY_REQUIRES_RECONCILIATION",
        )
    }
    fn enable(&self, device: &GpuDeviceUuid, end: Instant) -> Result<Enabled> {
        need(
            self.platform
                .catalogue()?
                .iter()
                .any(|value| value.device() == device),
            "GPU_HARDWARE_UNAVAILABLE",
        )?;
        let physical = self.platform.physical(device)?;
        let info = self.platform.info(end)?;
        let cdi = self.platform.cdi(&info, device, end)?;
        need(
            cdi.edits().numeric_nodes().len() == 1
                && cdi.edits().numeric_nodes()[0].scalar_text().as_deref()
                    == Some(format!("/dev/nvidia{}", physical.minor()).as_str()),
            "GPU_CDI_PHYSICAL_DEVICE_MISMATCH",
        )?;
        Ok(Enabled {
            physical,
            info,
            cdi,
        })
    }
    fn recheck_enabled(
        &self,
        device: &GpuDeviceUuid,
        enabled: Enabled,
        end: Instant,
    ) -> Result<CdiObservation> {
        let cdi = self.platform.cdi(&enabled.info, device, end)?;
        need(
            cdi.equivalent(&enabled.cdi)
                && self.platform.physical(device)? == enabled.physical
                && self.platform.info(end)?.equivalent(&enabled.info),
            "GPU_CDI_OR_HARDWARE_CHANGED",
        )?;
        cdi.assert_current()?;
        Ok(cdi)
    }
    fn check_peers(&self, candidate: &GpuCandidate, selected: &ProfileSessionId) -> Result<()> {
        let settings =
            reverie_contracts::resource_config::ResourceIdentitySettings::capture_worker_config(
                candidate.before(),
            )?;
        let identity = StorageIdentityConfig::capture_worker_settings(&settings);
        let company = storage_identity::read_company_metadata(&identity)?;
        for session in gpu_access::GpuPeerSessions::new(&company, selected)? {
            let session = session?;
            let session = ProfileSessionId::parse(
                &session
                    .scalar_text()
                    .ok_or(GateError::Refused("GPU_PEER_POLICY_CHANGED"))?,
            )?;
            let before =
                crate::resource_staging::effective_config(candidate.before().clone(), &session)?;
            let after =
                crate::resource_staging::effective_config(candidate.after().clone(), &session)?;
            need(
                worker_config::policy_digest(&before) == worker_config::policy_digest(&after),
                "GPU_PEER_POLICY_CHANGED",
            )?;
        }
        Ok(())
    }
    fn commit(
        &self,
        ready: Ready,
        end: Instant,
        lifecycle: &crate::installing_broker::LaptopLifecycle<'_>,
        retained: &mut Option<Arc<TransitionRecord>>,
    ) -> Result<Ending> {
        let parents = ready.files.capture_parents()?;
        let record = Arc::new(TransitionRecord::new(
            ready.files,
            ready.rows,
            ready.intent,
            ready.before,
            ready.after,
        ));
        let active = self.gate.inner.held(None)?;
        let mut slot = active
            .gpu_transition
            .lock()
            .map_err(|_| GateError::Refused("GPU_APPLY_REQUIRES_RECONCILIATION"))?;
        need(slot.is_none(), "GPU_APPLY_REQUIRES_RECONCILIATION")?;
        *slot = Some(record.clone());
        *retained = Some(record.clone());
        drop(slot);
        #[cfg(test)]
        super::tests::faults::at(super::tests::faults::Point::BeforePending, &record)?;
        record.publish_pending(end)?;
        let proof = record.publish_files(&ready.config_stamp, &ready.binding_stamp)?;
        self.gate.inner.publish_gpu(proof, lifecycle)?;
        #[cfg(test)]
        super::tests::faults::at(super::tests::faults::Point::RamPublished, &record)?;
        need(
            self.gate.inner.guard(None)?.equivalent(&record.rows)
                && self
                    .gate
                    .inner
                    .native_context()?
                    .inventory(Some(end))?
                    .equivalent(&record.rows),
            "GPU_NATIVE_CHANGED",
        )?;
        let employee = JournalId::parse(ready.current.data().identity().as_str())?;
        need(
            reverie_host::gpu_access::current_employee(record.intent.after(), &employee)?.data()
                == ready.current.data(),
            "GPU_CURRENT_CHANGED",
        )?;
        let terminal = record.terminal(
            ready.request_stamp.as_ref(),
            &ready.protected,
            ready.cdi.as_ref(),
        )?;
        Ok(Ending {
            record,
            terminal,
            parents,
            current: ready.current,
        })
    }
}
