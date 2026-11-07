//! Named cold purposes over the original returned Nix/storage resource pair.
use super::*;
use crate::{worker_laptop::LaptopError, worker_launch::ObservedCreatePlan};
use reverie_contracts::worker_cold_tmp::{ColdConfiguration, ColdStrategy};
impl NixReturned {
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
