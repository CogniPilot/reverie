//! Offline PERF transition under the original R owner. No runtime reload or
//! launch grant is created; the unstarted broker must close before release.
use super::*;
use reverie_contracts::{
    gpu_access::GpuCurrentEmployee, perf_transition::PerfTransition, worker_config,
};
use reverie_core::{ids::ProfileEmployeeId, operations::JournalDigest, task_perf::TaskPerfPolicy};
use reverie_host::gpu_access::{GpuFileStamp, PerfControlFiles};
use sha2::{Digest, Sha256};

pub(crate) struct PerfPreview {
    pub(crate) intent: Arc<PerfTransition>,
    pub(crate) configuration: GpuFileStamp,
    pub(crate) binding: GpuFileStamp,
    pub(crate) digest: JournalDigest,
    before: Arc<ValidatedWorkerSnapshot>,
    rows: Arc<ObservedInventory>,
    current: GpuCurrentEmployee,
    company: String,
}
pub(crate) struct PerfAdmission<'a> {
    gate: &'a ReservationGate,
    admission: Option<admission::Admission>,
}
impl ReservationGate {
    pub(crate) fn preview_offline_perf(
        &self,
        files: &mut PerfControlFiles,
        employee: ProfileEmployeeId,
        policy: Option<TaskPerfPolicy>,
        end: Instant,
    ) -> Result<PerfPreview> {
        let admission = self.inner.admit(AdmissionBounds {
            operation: Some(end),
            entry: Some(end),
        })?;
        let body = (|| {
            let before = self.inner.installed.snapshot()?;
            let config = before.configuration();
            let source = files.read_configuration()?;
            need(
                reverie_contracts::gpu_access::private_config_matches(config, source.metadata()),
                "PERF_CONFIGURATION_CHANGED",
            )?;
            let binding = files.read_binding()?;
            let (_, bound) = self.inner.installed.bound_resources(&self.inner.binding)?;
            need(
                bound.matches_metadata(binding.metadata()),
                "PERF_DOMAIN_CHANGED",
            )?;
            let intent = Arc::new(
                PerfTransition::prepare(config, employee, policy, &bound)
                    .map_err(GateError::PerfData)?,
            );
            before.validate_perf_candidate(&intent)?;
            let eid = JournalId::parse(intent.employee().as_str())?;
            let current = reverie_host::gpu_access::current_employee(config, &eid)?;
            self.inner.perf_peer_policies(&intent, &current)?;
            let company = self.inner.perf_company(config)?;
            let rows = Arc::new(self.inner.perf_idle(intent.employee(), &current, end)?);
            let mut census = rows
                .rows()
                .map(|row| {
                    Ok((
                        row.data().id().as_str().to_owned(),
                        row.data().snapshot_digest()?.to_hex(),
                    ))
                })
                .collect::<Result<Vec<_>>>()?;
            census.sort();
            let selected = serde_json::json!({"version":1,"purpose":"native-perf-cold-preview-v1",
                "before":worker_config::config_digest(config).to_hex(),
                "after":worker_config::config_digest(intent.after()).to_hex(),
                "sourceStamp":format!("{:?}",source.stamp()),"bindingStamp":format!("{:?}",binding.stamp()),
                "employee":intent.employee().as_str(), "policy":intent.policy().map(TaskPerfPolicy::name),
                "session":current.data().session().as_str(),"generation":current.generation().get(),
                "company":company,"census":census});
            let digest = JournalDigest::parse(&format!(
                "{:x}",
                Sha256::digest(serde_json::to_vec(&selected).expect("fixed PERF preview DATA"))
            ))?;
            let preview = PerfPreview {
                intent,
                configuration: source.stamp().clone(),
                binding: binding.stamp().clone(),
                digest,
                before,
                rows,
                current,
                company,
            };
            self.inner.assert_perf_preview(&preview, files, end)?;
            Ok(preview)
        })();
        admission.conclude(body)
    }
    pub(crate) fn enter_offline_perf<'a>(
        &'a self,
        preview: &PerfPreview,
        files: &mut PerfControlFiles,
        end: Instant,
    ) -> Result<PerfAdmission<'a>> {
        let admission = self.inner.admit(AdmissionBounds {
            operation: Some(end),
            entry: Some(end),
        })?;
        match self.inner.assert_perf_preview(preview, files, end) {
            Ok(()) => Ok(PerfAdmission {
                gate: self,
                admission: Some(admission),
            }),
            Err(e) => admission.conclude(Err(e)),
        }
    }
}
impl Inner {
    fn perf_peer_policies(
        &self,
        intent: &PerfTransition,
        current: &GpuCurrentEmployee,
    ) -> Result<()> {
        let settings =
            reverie_contracts::resource_config::ResourceIdentitySettings::capture_worker_config(
                intent.before(),
            )?;
        let identity =
            reverie_store::storage_identity::StorageIdentityConfig::capture_worker_settings(
                &settings,
            );
        let company = reverie_store::storage_identity::read_company_metadata(&identity)?;
        // This actual resolver verifies the selected compile-bound artifact and
        // projects only the current EID. No caller-supplied profile is accepted.
        let _selected = crate::resource_staging::effective_config(
            intent.after().clone(),
            current.data().session(),
        )?;
        for sid in
            reverie_contracts::gpu_access::GpuPeerSessions::new(&company, current.data().session())?
        {
            let sid = sid?;
            let sid = reverie_core::ids::ProfileSessionId::parse(
                &sid.scalar_text()
                    .ok_or(GateError::Refused("PERF_PEER_POLICY_CHANGED"))?,
            )?;
            let before = crate::resource_staging::effective_config(intent.before().clone(), &sid)?;
            let after = crate::resource_staging::effective_config(intent.after().clone(), &sid)?;
            need(
                worker_config::policy_digest(&before) == worker_config::policy_digest(&after),
                "PERF_PEER_POLICY_CHANGED",
            )?;
        }
        Ok(())
    }
    fn perf_company(
        &self,
        config: &reverie_contracts::worker_config::EffectiveWorkerConfig,
    ) -> Result<String> {
        let settings =
            reverie_contracts::resource_config::ResourceIdentitySettings::capture_worker_config(
                config,
            )?;
        let identity =
            reverie_store::storage_identity::StorageIdentityConfig::capture_worker_settings(
                &settings,
            );
        reverie_store::storage_identity::read_company_metadata(&identity)?
            .company_snapshot_digest()
            .map_err(|_| GateError::Refused("PERF_COMPANY_CHANGED"))
    }
    fn perf_idle(
        self: &Arc<Self>,
        employee: &ProfileEmployeeId,
        current: &GpuCurrentEmployee,
        end: Instant,
    ) -> Result<ObservedInventory> {
        self.held(None)?;
        self.require_host_job_idle()?;
        need(
            self.document()?.operations().is_empty(),
            "PERF_RESOURCE_HISTORY_REQUIRES_RECONCILIATION",
        )?;
        let rows = self.guard(None)?;
        let config = self.config()?;
        let context = self.native_context()?;
        need(
            context
                .custody_gpu_source(self.installed.snapshot()?.as_ref(), Some(end))?
                .equivalent(&rows),
            "PERF_NATIVE_CHANGED",
        )?;
        let selected = rows.gpu_selected(config.configuration(), current.data())?;
        for row in rows.rows() {
            if selected
                .as_ref()
                .is_some_and(|selected| selected.data().id() == row.data().id())
                || row.data().label_is("reverie.employee", employee.as_str())?
            {
                need(
                    !row.data().running()? && row.data().pid()?.is_zero(),
                    "PERF_EMPLOYEE_MUST_BE_STOPPED",
                )?;
                let stopped = context.stopped_state(&row, Some(end))?;
                use reverie_contracts::reservation_engine::StoppedFlag;
                need(
                    !stopped.flag(StoppedFlag::Running)
                        && !stopped.flag(StoppedFlag::Paused)
                        && !stopped.flag(StoppedFlag::Restarting)
                        && ["created", "exited", "dead"]
                            .iter()
                            .any(|s| stopped.status_is(s)),
                    "PERF_EMPLOYEE_MUST_BE_STOPPED",
                )?;
            }
        }
        need(
            context.inventory(Some(end))?.equivalent(&rows),
            "PERF_NATIVE_CHANGED",
        )?;
        Ok(rows)
    }
    fn assert_perf_preview(
        self: &Arc<Self>,
        preview: &PerfPreview,
        files: &mut PerfControlFiles,
        end: Instant,
    ) -> Result<()> {
        need(
            Instant::now() < end && Arc::ptr_eq(&self.installed.snapshot()?, &preview.before),
            "PERF_PREVIEW_CHANGED",
        )?;
        let config = preview.intent.before();
        let current = reverie_host::gpu_access::current_employee(
            config,
            &JournalId::parse(preview.intent.employee().as_str())?,
        )?;
        self.perf_peer_policies(&preview.intent, &current)?;
        need(
            current.data() == preview.current.data()
                && self.perf_company(config)? == preview.company,
            "PERF_EMPLOYEE_CHANGED",
        )?;
        let rows = self.perf_idle(preview.intent.employee(), &current, end)?;
        need(rows.equivalent(&preview.rows), "PERF_NATIVE_CHANGED")?;
        let source = files.read_configuration()?;
        let binding = files.read_binding()?;
        need(
            !files.host_history_present()?,
            "PERF_HOST_HISTORY_REQUIRES_RECONCILIATION",
        )?;
        need(
            source.stamp() == &preview.configuration
                && binding.stamp() == &preview.binding
                && reverie_contracts::gpu_access::private_config_matches(config, source.metadata()),
            "PERF_PREVIEW_CHANGED",
        )
    }
}
impl PerfAdmission<'_> {
    pub(crate) fn assert_after(&self, preview: &PerfPreview, end: Instant) -> Result<()> {
        need(Instant::now() < end, "PERF_DEADLINE")?;
        let context = self.gate.inner.native_context()?;
        need(
            context.inventory(Some(end))?.equivalent(&preview.rows),
            "PERF_NATIVE_CHANGED",
        )?;
        let current = reverie_host::gpu_access::current_employee(
            preview.intent.after(),
            &JournalId::parse(preview.intent.employee().as_str())?,
        )?;
        need(
            current.data() == preview.current.data()
                && self.gate.inner.perf_company(preview.intent.after())? == preview.company,
            "PERF_EMPLOYEE_CHANGED",
        )
    }
    pub(crate) fn close(&mut self) -> Result<()> {
        self.admission
            .take()
            .map_or(Ok(()), admission::Admission::abort)
    }
}
impl Drop for PerfAdmission<'_> {
    fn drop(&mut self) {
        if let Some(owner) = self.admission.take() {
            std::mem::forget(owner);
        }
    }
}
