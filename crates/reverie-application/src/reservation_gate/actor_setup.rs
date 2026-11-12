//! Initial actor metadata admission under the same original reservation lock.
//! No worker stop/start or resource-pool consent follows from this admission.
use super::*;
use reverie_contracts::{resource_actor::ActorSetupTransition, worker_config};
use reverie_core::operations::JournalDigest;
use reverie_host::gpu_access::{ActorSetupControlFiles, GpuFileStamp};
use sha2::{Digest, Sha256};
use std::sync::MutexGuard;

pub(crate) struct ActorSetupPreview {
    pub(crate) intent: Arc<ActorSetupTransition>,
    pub(crate) configuration: GpuFileStamp,
    pub(crate) binding: GpuFileStamp,
    pub(crate) digest: JournalDigest,
    before: Arc<ValidatedWorkerSnapshot>,
    rows: Arc<ObservedInventory>,
    company: String,
}
pub(crate) struct ActorSetupAdmission<'a> {
    gate: &'a ReservationGate,
    active: Arc<Active>,
    admission: Option<admission::Admission>,
    end: Instant,
}
impl ReservationGate {
    pub(crate) fn preview_offline_actor_setup(
        &self,
        files: &mut ActorSetupControlFiles,
        end: Instant,
    ) -> Result<ActorSetupPreview> {
        let admission = self.inner.admit(AdmissionBounds {
            operation: Some(end),
            entry: Some(end),
        })?;
        let body = (|| {
            let before = self.inner.installed.snapshot()?;
            let source = files
                .read_configuration()
                .map_err(|error| GateError::Refused(error.code()))?;
            let binding = files
                .read_binding()
                .map_err(|error| GateError::Refused(error.code()))?;
            let (_, bound) = self.inner.installed.bound_resources(&self.inner.binding)?;
            let intent = files
                .prepare_transition(&bound)
                .map_err(|error| GateError::Refused(error.code()))?;
            before.validate_actor_setup_candidate(&intent)?;
            need(
                intent.matches_before_configuration(source.metadata())
                    && intent.matches_before_binding(binding.metadata())
                    && worker_config::equivalent(before.configuration(), intent.before()),
                "ACTOR_SETUP_CONFIGURATION_CHANGED",
            )?;
            self.inner.actor_peer_policies(&intent)?;
            let company = self
                .inner
                .transition_company_digest(intent.before(), "ACTOR_SETUP_COMPANY_CHANGED")?;
            let rows = Arc::new(self.inner.actor_setup_rows(end)?);
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
            let data = serde_json::json!({"version":1,"purpose":"native-actor-setup-preview-v1",
                "before":worker_config::config_digest(intent.before()).to_hex(),
                "after":worker_config::config_digest(intent.after()).to_hex(),
                "sourceStamp":format!("{:?}",source.stamp()),
                "bindingStamp":format!("{:?}",binding.stamp()),"company":company,"census":census});
            let digest = JournalDigest::parse(&format!(
                "{:x}",
                Sha256::digest(serde_json::to_vec(&data).expect("fixed actor preview DATA"))
            ))?;
            let preview = ActorSetupPreview {
                intent,
                configuration: source.stamp().clone(),
                binding: binding.stamp().clone(),
                digest,
                before,
                rows,
                company,
            };
            self.inner
                .assert_actor_setup_preview(&preview, files, end)?;
            Ok(preview)
        })();
        admission.conclude(body)
    }
    pub(crate) fn enter_offline_actor_setup<'a>(
        &'a self,
        preview: &ActorSetupPreview,
        files: &mut ActorSetupControlFiles,
        end: Instant,
    ) -> Result<ActorSetupAdmission<'a>> {
        let admission = self.inner.admit(AdmissionBounds {
            operation: Some(end),
            entry: Some(end),
        })?;
        let body = (|| {
            self.inner.assert_actor_setup_preview(preview, files, end)?;
            self.inner.held(None)
        })();
        match body {
            Ok(active) => Ok(ActorSetupAdmission {
                gate: self,
                active,
                admission: Some(admission),
                end,
            }),
            Err(error) => admission.conclude(Err(error)),
        }
    }
}
impl Inner {
    fn actor_peer_policies(&self, intent: &ActorSetupTransition) -> Result<()> {
        let company = reverie_store::storage_identity::read_company_metadata(&self.identity)?;
        let sessions = company
            .company_records()
            .and_then(|records| records.session_employees())
            .map_err(reverie_store::storage_identity::IdentityError::from)?;
        for session in sessions.keys() {
            let before =
                crate::resource_staging::effective_config(intent.before().clone(), session)?;
            let after = crate::resource_staging::effective_config(intent.after().clone(), session)?;
            need(
                worker_config::policy_digest(&before) == worker_config::policy_digest(&after),
                "ACTOR_SETUP_EMPLOYEE_POLICY_CHANGED",
            )?;
        }
        Ok(())
    }
    fn actor_setup_rows(self: &Arc<Self>, end: Instant) -> Result<ObservedInventory> {
        self.held(None)?;
        self.require_host_job_idle()?;
        let document = self.document()?;
        let active = self.active_operations(&document)?;
        need(
            active.is_empty() && document.operations().is_empty(),
            "ACTOR_SETUP_RESOURCE_HISTORY_REQUIRES_RECONCILIATION",
        )?;
        let rows = self.guard(None)?;
        let context = self.native_context()?;
        need(
            context
                .custody_gpu_source(self.installed.snapshot()?.as_ref(), Some(end))?
                .equivalent(&rows)
                && context.inventory(Some(end))?.equivalent(&rows),
            "ACTOR_SETUP_NATIVE_CHANGED",
        )?;
        Ok(rows)
    }
    fn assert_actor_setup_preview(
        self: &Arc<Self>,
        preview: &ActorSetupPreview,
        files: &mut ActorSetupControlFiles,
        end: Instant,
    ) -> Result<()> {
        need(
            Instant::now() < end && Arc::ptr_eq(&self.installed.snapshot()?, &preview.before),
            "ACTOR_SETUP_PREVIEW_CHANGED",
        )?;
        self.actor_peer_policies(&preview.intent)?;
        need(
            self.transition_company_digest(preview.intent.before(), "ACTOR_SETUP_COMPANY_CHANGED")?
                == preview.company
                && self.actor_setup_rows(end)?.equivalent(&preview.rows),
            "ACTOR_SETUP_NATIVE_CHANGED",
        )?;
        let source = files
            .read_configuration()
            .map_err(|error| GateError::Refused(error.code()))?;
        let binding = files
            .read_binding()
            .map_err(|error| GateError::Refused(error.code()))?;
        need(
            source.stamp() == &preview.configuration
                && binding.stamp() == &preview.binding
                && preview
                    .intent
                    .matches_before_configuration(source.metadata())
                && preview.intent.matches_before_binding(binding.metadata()),
            "ACTOR_SETUP_PREVIEW_CHANGED",
        )
    }
}
impl ActorSetupAdmission<'_> {
    pub(crate) fn lock(&self) -> Result<MutexGuard<'_, AdmissionLock>> {
        need(
            self.admission.is_some()
                && Arc::ptr_eq(&self.gate.inner.held(None)?, &self.active)
                && Instant::now() < self.gate.inner.native_context()?.deadline(Some(self.end))?,
            "ACTOR_SETUP_ADMISSION_CHANGED",
        )?;
        self.active
            .lock
            .lock()
            .map_err(|_| GateError::Refused("RESERVATION_ADMISSION_UNAVAILABLE"))
    }
    pub(crate) fn assert_after(&self, preview: &ActorSetupPreview, end: Instant) -> Result<()> {
        need(
            self.admission.is_some() && Arc::ptr_eq(&self.gate.inner.held(None)?, &self.active),
            "ACTOR_SETUP_ADMISSION_CHANGED",
        )?;
        let context = self.gate.inner.native_context()?;
        let end = context.deadline(Some(end.min(self.end)))?;
        need(
            Instant::now() < end
                && context.inventory(Some(end))?.equivalent(&preview.rows)
                && self.gate.inner.transition_company_digest(
                    preview.intent.after(),
                    "ACTOR_SETUP_COMPANY_CHANGED",
                )? == preview.company,
            "ACTOR_SETUP_NATIVE_CHANGED",
        )?;
        self.gate.inner.actor_peer_policies(&preview.intent)
    }
    pub(crate) fn close(&mut self) -> Result<()> {
        self.admission
            .take()
            .map_or(Ok(()), admission::Admission::abort)
    }
}
impl Drop for ActorSetupAdmission<'_> {
    fn drop(&mut self) {
        if let Some(owner) = self.admission.take() {
            std::mem::forget(owner);
        }
    }
}
