//! Real installing-file reload, serialized with this broker's ordered lifecycle
//! registry. No candidate setter, caller validator, or synthetic registry exists.
use super::*;
use reverie_contracts::{broker_laptop::BrokerLaptopInspection, resource_reload, worker_config};
use reverie_core::operations::{OperationDocument, OperationState};
pub(crate) struct InspectedReload {
    before: Arc<ValidatedWorkerSnapshot>,
    updated: Arc<ValidatedWorkerSnapshot>,
}
impl InspectedReload {
    pub(crate) fn into_snapshots(
        self,
    ) -> (Arc<ValidatedWorkerSnapshot>, Arc<ValidatedWorkerSnapshot>) {
        (self.before, self.updated)
    }
}
impl ReservationGate {
    pub(crate) fn reload_owner_configuration(&self) -> Result<()> {
        let admission = self.inner.admit(AdmissionBounds::default())?;
        let result = self.inner.reload_current(None);
        admission.conclude(result)
    }
}
impl Inner {
    pub(super) fn reload_current(
        self: &Arc<Self>,
        mut preparation: Option<&mut RetainedPreparation>,
    ) -> Result<()> {
        self.held(None)?;
        let path = self
            .source_path
            .as_ref()
            .ok_or(GateError::Refused("WORKER_RESOURCE_RELOAD_FILE_REQUIRED"))?;
        let _lifecycle = self.installed.lifecycle()?;
        let before = self.installed.snapshot()?;
        let updated = Arc::new(crate::worker_validation::load_owner_config(path)?);
        resource_reload::validate_reload(before.configuration(), updated.configuration())?;
        let document = self.document()?;
        if !self.active_operations(&document)?.is_empty()
            && !worker_config::equivalent(before.configuration(), updated.configuration())
        {
            let claim = preparation.as_deref().ok_or(GateError::Refused(
                "RESOURCE_RESERVATION_REQUIRES_PROTECTED_RECONCILIATION",
            ))?;
            self.allow_preparing_reload(claim, updated.configuration(), &document)?;
        }
        let native = self.native_context()?;
        for (sid, name) in _lifecycle.entries() {
            let previous = native.inspect_laptop(name, None)?;
            need(
                previous.succeeded,
                "WORKER_RESOURCE_RELOAD_LAPTOP_UNAVAILABLE",
            )?;
            let inspected = BrokerLaptopInspection::decode(&previous.stdout)?;
            if let Some(running) =
                inspected.running_identity(before.envelope().base().deployment(), sid)?
            {
                let effective = crate::resource_staging::effective_config(
                    updated.configuration().clone(),
                    sid,
                )?;
                running.assert_policy(&worker_config::policy_digest(&effective))?;
            }
        }
        let active = self.held(None)?;
        let mut context = active
            .context
            .lock()
            .map_err(|_| GateError::Refused("RESERVATION_ADMISSION_UNAVAILABLE"))?;
        self.installed
            .install_reloaded(InspectedReload { before, updated }, &mut context)?;
        if let Some(claim) = preparation.as_mut() {
            claim
                .policy
                .as_mut()
                .expect("protected reload phase")
                .installed = true;
        }
        Ok(())
    }
    fn allow_preparing_reload(
        self: &Arc<Self>,
        claim: &RetainedPreparation,
        updated: &reverie_contracts::worker_config::EffectiveWorkerConfig,
        document: &OperationDocument,
    ) -> Result<()> {
        let phase = claim.policy.as_ref().ok_or(GateError::Refused(
            "RESOURCE_PREPARATION_RELOAD_CONTEXT_REQUIRED",
        ))?;
        need(
            Arc::ptr_eq(self, &claim.gate)
                && claim.store.is_some()
                && phase.published
                && !phase.installed
                && document.operations().get(claim.operation_id()) == Some(claim.view.record())
                && claim.view.state() == OperationState::Preparing
                && worker_config::equivalent(updated, phase.candidate.configuration())
                && worker_config::equivalent(
                    self.config()?.configuration(),
                    claim.source_configuration(),
                ),
            "RESOURCE_PREPARATION_RELOAD_CHANGED",
        )?;
        self.finish_preparation(claim, super::preparation_phase::PublicationPhase::After)
    }
}
