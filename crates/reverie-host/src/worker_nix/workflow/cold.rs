//! Named cold purposes over the original returned Nix/storage resource pair.
use super::*;
use crate::{worker_laptop::LaptopError, worker_launch::ObservedCreatePlan};
use reverie_contracts::worker_cold_tmp::{ColdConfiguration, ColdStrategy};
impl Workflows {
    fn prepare_retained_cold(
        &self,
        runtime: &WorkerRuntime,
        workflow: &NixWorkflow,
        plan: &ObservedCreatePlan,
        deadline: Instant,
    ) -> Result<()> {
        self.bound(runtime, workflow)?;
        let mut record = workflow
            .record
            .try_lock()
            .map_err(|_| NixError::Refused(NixFault::Retained))?;
        need(
            record.phase == Phase::Known && !record.turn && matches!(&record.outcome, Some(Ok(_))),
            NixFault::Retained,
        )?;
        plan.assert_storage_owner(runtime, &record.resources().storage)
            .map_err(|_| NixError::Refused(NixFault::StoreBinding))?;
        record.resources().guard.assert_current()?;
        record.resources().storage.require_cold_unattempted()?;
        record.phase = Phase::Running;
        let result = record
            .resources_mut()
            .storage
            .prepare_retained_cold_temporary(runtime, plan, deadline)
            .map_err(NixError::Owner);
        match result {
            Ok(()) => {
                record.phase = Phase::Known;
                Ok(())
            }
            Err(error) => {
                if let NixError::Owner(cause) = &error {
                    // Known local cleanup cannot turn a lost cold publication
                    // or retained native call into a reclaimable Nix success.
                    record.unknown_effect |= cause.unconfirmed_native();
                }
                record.note(error);
                record.phase = Phase::Retained;
                Err(NixError::Refused(NixFault::Retained))
            }
        }
    }
}
impl WorkerRuntime {
    /// Pre-Office retained publication on the SAME successful Nix resource
    /// record. No paths, CID, ready DTO or native-guard callback are accepted.
    pub fn prepare_retained_cold_tmp(
        &self,
        workflow: &NixWorkflow,
        plan: &ObservedCreatePlan,
        deadline: Instant,
    ) -> Result<()> {
        self.nix_workflows()
            .prepare_retained_cold(self, workflow, plan, deadline)
    }
}
impl NixReturned {
    pub(crate) fn begin_retained_cold_commit(
        &mut self,
        source: &EffectiveWorkerConfig,
        native: &crate::worker_laptop::cold_confirm::Confirmed,
        end: Instant,
    ) -> std::result::Result<(), LaptopError> {
        self.resources
            .guard
            .assert_current()
            .map_err(LaptopError::Nix)?;
        self.resources
            .storage
            .begin_retained_cold_commit(source, native, end)
            .map_err(LaptopError::ColdStorage)
    }
    pub(crate) fn release_retained_cold_commit(
        &mut self,
        source: &EffectiveWorkerConfig,
        native: &crate::worker_laptop::cold_confirm::Confirmed,
        end: Instant,
    ) -> std::result::Result<(), LaptopError> {
        self.resources
            .guard
            .assert_current()
            .map_err(LaptopError::Nix)?;
        self.resources
            .storage
            .release_retained_cold_commit(source, native, end)
            .map_err(LaptopError::ColdStorage)
    }
    pub(crate) fn prepare_laptop_cold_temporary(
        &mut self,
        runtime: &WorkerRuntime,
        plan: &ObservedCreatePlan,
        end: Instant,
    ) -> std::result::Result<(), LaptopError> {
        self.assert_create_plan(runtime, plan)
            .map_err(LaptopError::Plan)?;
        self.resources
            .guard
            .assert_current()
            .map_err(LaptopError::Nix)?;
        let policy = ColdConfiguration::capture(plan.source()).map_err(|error| {
            LaptopError::ColdStorage(crate::worker_storage::StorageOwnerError::ColdData(error))
        })?;
        match policy.as_ref().map(ColdConfiguration::strategy) {
            Some(ColdStrategy::Clear) => self
                .resources
                .storage
                .clear_cold_temporary(runtime, plan, end),
            // The retained branch must have genuinely prepared on this same
            // storage owner before Office/network; no fallback clear or no-op.
            Some(ColdStrategy::RetainAndReplace) | None => {
                self.resources.storage.require_cold_prepared(plan.source())
            }
        }
        .map_err(LaptopError::ColdStorage)
    }
    pub(crate) fn require_cold_prepared(
        &self,
        source: &EffectiveWorkerConfig,
    ) -> std::result::Result<(), LaptopError> {
        self.resources
            .storage
            .require_cold_prepared(source)
            .map_err(LaptopError::ColdStorage)
    }
}
