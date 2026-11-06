//! Actual retained canonical claim + original native baseline producer. This
//! has no start/stop/configuration-commit method; those effect owners remain
//! unavailable until their complete protected producer is implemented.
use super::claim::{ClaimedContext, TerminalClaim};
use super::*;
use crate::reservation_observer::WebsiteBinding;
use reverie_contracts::{
    reservation_baseline::{OriginalBaselineFields, OriginalSourceBaseline},
    reservation_draft::DraftRecord,
    reservation_observation::{self, PoolWebsite},
    worker_config::EffectiveWorkerConfig,
};
use reverie_core::operations::JournalDigest;
use reverie_store::{
    operations::{ClaimSelection, OperationHandle},
    storage_identity::{self, StorageKind, StoragePaths},
};

/// Nonserializable process-local owner produced only by an actual held Gate
/// claim and native capture. Data accessors convey no permission to effects.
/// Dropping/closing retains the durable reservation and target-session fence.
pub struct RetainedPreparation {
    gate: Arc<Inner>,
    store: Option<OperationStore>,
    handle: OperationHandle,
    view: OperationView,
    terminal: TerminalClaim,
    before: EffectiveWorkerConfig,
    paths: StoragePaths,
    baseline: OriginalSourceBaseline,
}
impl RetainedPreparation {
    pub fn operation(&self) -> &OperationView {
        &self.view
    }
    pub fn operation_id(&self) -> &JournalId {
        self.handle.operation_id()
    }
    pub fn scope(&self) -> &OperationScope {
        &self.gate.scope
    }
    pub fn profile(&self) -> &reverie_core::profiles::ResourceProfile {
        &self.terminal.profile
    }
    pub fn source_configuration(&self) -> &EffectiveWorkerConfig {
        &self.before
    }
    pub fn source_paths(&self) -> &StoragePaths {
        &self.paths
    }
    pub fn original_baseline(&self) -> &OriginalSourceBaseline {
        &self.baseline
    }
    /// Checked exactly-once owned-store close; this does not release capacity,
    /// clear a target fence, acknowledge completion or permit retry.
    pub fn close(mut self) -> Result<()> {
        self.store
            .take()
            .expect("live retained owner")
            .close()
            .map_err(Into::into)
    }
}
impl ReservationGate {
    /// Fixed private preparation entry. The draft hash binds DATA only; fresh
    /// actual admission, canonical claim and native baseline are mandatory.
    pub fn retain_draft(
        &self,
        id: &JournalId,
        digest: &JournalDigest,
    ) -> Result<RetainedPreparation> {
        let metadata = reservation_control::read_draft(&self.inner.config, id)?;
        let draft = DraftRecord::capture(&metadata, id, &self.inner.scope, digest)?;
        let profile = self.inner.profile(&draft.employee()?)?;
        draft.assert_current_profile(profile.as_ref())?;
        let request =
            draft.comparison_request(profile.as_ref().expect("checked current profile"))?;
        let admission = self.inner.admit(AdmissionBounds::default())?;
        let mut claimed = false;
        let selected = ClaimSelection {
            operation_id: Some(draft.operation()),
            reservation_id: Some(draft.reservation()),
            reserved_sid: None,
        };
        let body = self.inner.claim_reservation(
            &draft.key(),
            &request,
            selected,
            Some(&draft),
            &mut claimed,
        );
        let result = match body {
            Err(error) => admission.conclude(Err(error)),
            Ok(context) => self.retain_context(admission, context),
        };
        if claimed {
            result.map_err(|error| match error {
                GateError::Journal(error) if error.is_uncertain() => GateError::Journal(error),
                other => GateError::ClaimUncertain {
                    cause: Box::new(other),
                },
            })
        } else {
            result
        }
    }
    fn retain_context(
        &self,
        admission: super::admission::Admission,
        context: ClaimedContext,
    ) -> Result<RetainedPreparation> {
        let body = (|| {
            need(
                context.handle.is_some(),
                "RESERVATION_REPLAY_HAS_NO_ACTIVE_HANDLE",
            )?;
            let before = self.inner.config.configuration().clone();
            let binding = context.terminal.profile.binding();
            let paths =
                storage_identity::storage_paths(&self.inner.identity, binding.current_session())?;
            need(
                paths.kind() == StorageKind::Employee
                    && paths.identity() == binding.employee().as_str(),
                "RESOURCE_PREPARATION_STORAGE_CHANGED",
            )?;
            let baseline = self.inner.capture_original(&context.terminal, &paths)?;
            Ok((before, paths, baseline))
        })();
        match body {
            Err(error) => admission.conclude(finalized(
                Err(error),
                context.store.close().map_err(Into::into),
            )),
            Ok((before, paths, baseline)) => {
                if let Err(error) = admission.finish_claim(&context.terminal) {
                    return finalized(Err(error), context.store.close().map_err(Into::into));
                }
                Ok(RetainedPreparation {
                    gate: self.inner.clone(),
                    store: Some(context.store),
                    handle: context.handle.expect("checked handle"),
                    view: context.view,
                    terminal: context.terminal,
                    before,
                    paths,
                    baseline,
                })
            }
        }
    }
}
impl Inner {
    fn capture_original(
        &self,
        claim: &TerminalClaim,
        paths: &StoragePaths,
    ) -> Result<OriginalSourceBaseline> {
        let deployment = self.config.deployment()?;
        let mut source = None;
        for row in claim.native.rows() {
            if row.data().label_is("reverie.worker", &deployment)?
                && row.data().label_is(
                    "reverie.session",
                    claim.profile.binding().current_session().as_str(),
                )?
            {
                need(source.is_none(), "RESOURCE_NATIVE_SOURCE_REQUIRED")?;
                source = Some(row);
            }
        }
        let source = source.ok_or(GateError::Refused("RESOURCE_NATIVE_SOURCE_REQUIRED"))?;
        let native = self.native_context()?;
        let limits = native.limits(&source)?;
        let storage = native.storage(&source, paths)?;
        let capacity = native.capacity(&claim.native)?;
        let observed = claim.observed.fields();
        need(
            reservation_observation::claim_source_binding_digest(
                &claim.employee,
                &limits,
                &storage,
                &claim.profile,
            )? == observed.source_binding,
            "RESOURCE_NATIVE_SOURCE_CHANGED",
        )?;
        let WebsiteBinding::Running(site) = capacity.website() else {
            return Err(GateError::Refused("RESOURCE_NATIVE_CAPACITY_CHANGED"));
        };
        need(
            reservation_observation::pool_revision_digest(
                &observed.pool,
                capacity.budget(),
                PoolWebsite::Running(site),
                self.option.host_reserve_mib(),
                capacity.commitments(),
            )? == observed.pool_revision,
            "RESOURCE_NATIVE_CAPACITY_CHANGED",
        )?;
        let runtime = native.original_runtime_tail(&source, &limits)?;
        Ok(OriginalSourceBaseline::from_observed_data(
            OriginalBaselineFields {
                source: source.data(),
                native: &limits,
                storage: &storage,
                site,
                commitments: capacity.commitments(),
                total: capacity.total(),
                budget: capacity.budget(),
                runtime: &runtime,
            },
        ))
    }
}
