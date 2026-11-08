//! Actual one-attempt PREPARING/publication observations using the retained
//! canonical handle. This publishes no company binding or configuration and
//! supplies no start/stop/CLI readiness or mutable broker reload permission.
use super::preparation::RetainedPreparation;
use super::*;
use reverie_contracts::{
    profiles_v1,
    reservation_observation::{self, PoolWebsite},
    reservation_publication::{PublicationFields, PublicationIntent},
    worker_config,
};
use reverie_core::{
    ids::ProfileSessionId,
    operations::{Effect, JournalDigest},
};
use reverie_store::storage_identity::{self, StorageKind};
pub(super) struct PublicationBoundary {
    pub(super) receipt: PublicationIntent,
    pub(super) signature: reservation_control::PublicationStamp,
}
#[derive(Clone, Copy)]
pub(super) enum PublicationPhase {
    Before,
    After,
}
pub struct PreparationIntentFacts {
    pub digest: JournalDigest,
    pub target: ProfileSessionId,
}
impl RetainedPreparation {
    fn require_live(&self) -> Result<()> {
        need(
            self.journal_available(),
            "RESOURCE_PREPARATION_ACTIVE_HANDLE_REQUIRED",
        )
    }
    /// Latch before attempting admission. Every later error closes the actual
    /// retained store, keeps the durable claim, and forbids another attempt.
    pub fn begin_prepare(&mut self) -> Result<PreparationIntentFacts> {
        self.require_live()?;
        need(
            !self.preparing_attempted,
            "RESOURCE_PREPARATION_ALREADY_ATTEMPTED",
        )?;
        self.preparing_attempted = true;
        let result = self.prepare_attempt();
        match result {
            Ok(value) => Ok(value),
            Err(error) => Err(GateError::PreparationIntentUncertain {
                cause: Box::new(finalized::<()>(Err(error), self.close_owned()).unwrap_err()),
            }),
        }
    }
    fn prepare_attempt(&mut self) -> Result<PreparationIntentFacts> {
        let admission = self.admit_preparation()?;
        match self.prepare_body() {
            Ok(()) => admission.finish_preparation(self, PublicationPhase::Before)?,
            Err(error) => return admission.conclude(Err(error)),
        };
        let receipt = &self.publication.as_ref().expect("published intent").receipt;
        Ok(PreparationIntentFacts {
            digest: receipt.digest(),
            target: self.profile().binding().target_session().clone(),
        })
    }
    fn prepare_body(&mut self) -> Result<()> {
        let eid = self.terminal.profile.binding().employee();
        let (observed, _native) = self.gate.observe_claim(
            &self.gate.scope,
            self.gate.option.pool(),
            eid,
            &self.terminal.profile,
        )?;
        need(
            observed.canonical_bytes() == self.terminal.observed.canonical_bytes(),
            "RESOURCE_PREPARATION_SOURCE_CHANGED",
        )?;
        self.view = self.journal_begin_effect(
            Effect::Prepare,
            self.view.record().data().version,
        )?;
        let receipt = PublicationIntent::from_observed_data(PublicationFields {
            operation: self.view.record(),
            profile: &self.terminal.profile,
            employee: &self.terminal.employee,
            baseline: self.original_baseline(),
            before: self.source_configuration(),
        })?;
        let signature =
            reservation_control::publish_publication(self.gate.config()?.as_ref(), &receipt)?;
        self.publication = Some(PublicationBoundary { receipt, signature });
        self.journal_confirm_preparation()?;
        Ok(())
    }
    /// Observe the normal server's exact intended rebind. This does not perform
    /// that write, acknowledge CLI readiness, release capacity or permit retry.
    pub fn confirm_publication(&mut self) -> Result<()> {
        self.require_live()?;
        need(
            self.preparing_attempted && self.publication.is_some(),
            "RESOURCE_PREPARATION_INTENT_REQUIRED",
        )?;
        let result = (|| {
            let admission = self.admit_preparation()?;
            admission.finish_preparation(self, PublicationPhase::After)
        })();
        match result {
            Ok(()) => {
                self.published = true;
                Ok(())
            }
            Err(error) => Err(GateError::PreparationPublicationUncertain {
                cause: Box::new(finalized::<()>(Err(error), self.close_owned()).unwrap_err()),
            }),
        }
    }
}
impl Inner {
    pub(super) fn finish_preparation(
        self: &Arc<Self>,
        claim: &RetainedPreparation,
        phase: PublicationPhase,
    ) -> Result<()> {
        need(
            Arc::ptr_eq(self, &claim.gate) && claim.journal_available(),
            "RESOURCE_PREPARATION_BOUNDARY_REQUIRED",
        )?;
        let boundary = claim
            .publication
            .as_ref()
            .ok_or(GateError::Refused("RESOURCE_PREPARATION_INTENT_REQUIRED"))?;
        let stamp = self
            .store()?
            .into_preparation_terminal_stamp(&self.scope, &claim.view)?;
        let file = reservation_control::observe_publication(
            self.config()?.as_ref(),
            claim.operation_id(),
            &boundary.signature,
            &boundary.receipt,
        )?;
        let rows = self.guard(None)?;
        need(
            rows.equivalent(&claim.terminal.native),
            "RESOURCE_PREPARATION_NATIVE_CHANGED",
        )?;
        let native = self.native_context()?;
        let capacity = native.capacity(&rows)?;
        let site = match capacity.website() {
            crate::reservation_observer::WebsiteBinding::Running(value) => {
                PoolWebsite::Running(value)
            }
            crate::reservation_observer::WebsiteBinding::Stopped(value) => {
                PoolWebsite::Stopped(value)
            }
        };
        let observed = claim.terminal.observed.fields();
        need(
            reservation_observation::pool_revision_digest(
                &observed.pool,
                capacity.budget(),
                site,
                self.option.host_reserve_mib(),
                capacity.commitments(),
            )? == observed.pool_revision
                && capacity.total().as_str() == observed.committed_bytes.to_string()
                && capacity.budget().as_str() == observed.budget_bytes.to_string(),
            "RESOURCE_PREPARATION_CAPACITY_CHANGED",
        )?;
        let source = rows
            .rows()
            .find(|row| row.data().id() == claim.original_baseline().source_container())
            .ok_or(GateError::Refused("RESOURCE_PREPARATION_SOURCE_CHANGED"))?;
        let limits = native.limits(&source)?;
        let storage = native.storage(&source, claim.source_paths())?;
        need(
            reservation_observation::claim_source_binding_digest(
                &claim.terminal.employee,
                &limits,
                &storage,
                &claim.terminal.profile,
            )? == observed.source_binding,
            "RESOURCE_PREPARATION_SOURCE_CHANGED",
        )?;
        if let Some(phase) = &claim.policy {
            native.custody_policy(&phase.binding, None)?;
        }
        need(
            self.guard(None)?.equivalent(&rows),
            "RESOURCE_PREPARATION_NATIVE_CHANGED",
        )?;
        // No further engine/kernel/custody producer may follow these stamps.
        claim.assert_policy_current()?;
        stamp.assert_preparation_named_current()?;
        file.assert_named_current()?;
        self.finish_preparation_metadata(claim, phase)
    }
    fn finish_preparation_metadata(
        &self,
        claim: &RetainedPreparation,
        phase: PublicationPhase,
    ) -> Result<()> {
        let boundary = claim.publication.as_ref().expect("checked boundary");
        need(
            worker_config::equivalent(
                self.config()?.configuration(),
                claim.expected_live_configuration(),
            ),
            "RESOURCE_PREPARATION_CONFIG_CHANGED",
        )?;
        let binding = claim.terminal.profile.binding();
        need(
            self.profile(binding.employee())?
                .as_ref()
                .is_some_and(|profile| profiles_v1::equivalent(profile, &claim.terminal.profile)),
            "RESOURCE_PREPARATION_PROFILE_CHANGED",
        )?;
        let expected = match phase {
            PublicationPhase::Before => boundary.receipt.before_employee(),
            PublicationPhase::After => boundary.receipt.after_employee(),
        };
        need(
            expected.still_current(&storage_identity::read_company_metadata(&self.identity)?)?,
            "RESOURCE_PREPARATION_PUBLICATION_CHANGED",
        )?;
        let target = storage_identity::storage_paths(&self.identity, binding.target_session())?;
        let valid = match phase {
            PublicationPhase::After => {
                target.kind() == StorageKind::Employee
                    && target.identity() == binding.employee().as_str()
                    && target.home() == claim.source_paths().home()
                    && target.nix() == claim.source_paths().nix()
                    && target.scratch() == claim.source_paths().scratch()
                    && storage_identity::storage_start_allowed(&self.identity, &target)?
            }
            PublicationPhase::Before => {
                let source =
                    storage_identity::storage_paths(&self.identity, binding.current_session())?;
                source == *claim.source_paths()
                    && storage_identity::storage_start_allowed(
                        &self.identity,
                        claim.source_paths(),
                    )?
                    && target.kind() == StorageKind::Session
                    && target.identity() == binding.target_session().as_str()
                    && !reservation_control::session_directory_present(
                        self.config()?.as_ref(),
                        binding.target_session(),
                    )?
            }
        };
        need(valid, "RESOURCE_PREPARATION_STORAGE_CHANGED")
    }
}
