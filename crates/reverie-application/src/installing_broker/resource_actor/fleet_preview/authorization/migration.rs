//! Distinct actual migration consent. A drain-only approval cannot enter this
//! owner or transfer the original installation source.
use super::*;
use crate::reservation_gate::PoolTransitionFence;
use reverie_host::worker_reports::{
    WorkerHandlersProgress, WorkerOriginalHandlersClosed, WorkerOriginalHandlersDrain,
};

#[must_use = "retain the original migration Q and selected handler owners"]
pub struct AuthenticatedPoolMigration<'a> {
    pub(super) authorization: AuthenticatedFleetMaintenance<'a>,
}
#[must_use = "retain the original drained resources through paired publication"]
pub struct DrainedPoolMigration<'a> {
    pub(super) fleet: DrainedLegacyFleet<'a>,
}
mod commit;
mod publication;
mod source;
pub(in crate::installing_broker) use source::PoolMigrationSourceAuthorization;
impl<'a> AuthenticatedFleetMaintenance<'a> {
    pub fn into_pool_migration(
        self,
    ) -> Result<AuthenticatedPoolMigration<'a>, Box<FleetPreviewFailure<'a>>> {
        if !self
            .owner
            .maintenance_request
            .as_ref()
            .is_some_and(|request| request.action() == FleetMaintenanceAction::MigratePool)
        {
            return Err(self
                .owner
                .into_failure(Cause::Refused("POOL_MIGRATION_CONSENT_REQUIRED")));
        }
        Ok(AuthenticatedPoolMigration {
            authorization: self,
        })
    }
}
impl<'a> AuthenticatedPoolMigration<'a> {
    pub fn advance_original_handlers(
        &mut self,
        fence: &PoolTransitionFence,
        drain: &mut WorkerOriginalHandlersDrain,
    ) -> std::result::Result<
        reverie_host::worker_reports::WorkerOriginalInterruptionProgress,
        FleetMaintenanceCheckError,
    > {
        self.authorization.advance_original_handlers(fence, drain)
    }
    pub fn selection(&self) -> &reverie_contracts::reservation_control::PoolTransitionSelection {
        self.authorization.selection()
    }
    pub fn retain_original_handlers(
        &mut self,
    ) -> std::result::Result<WorkerOriginalHandlersDrain, FleetMaintenanceCheckError> {
        self.authorization.retain_original_handlers()
    }
    pub fn bind_original_cleanup(
        &mut self,
        fence: &mut PoolTransitionFence,
        drain: &WorkerOriginalHandlersDrain,
    ) -> std::result::Result<(), FleetMaintenanceCheckError> {
        self.authorization.bind_original_cleanup(fence, drain)
    }
    pub fn interrupt_original_handlers(
        &mut self,
        fence: &PoolTransitionFence,
        drain: &mut WorkerOriginalHandlersDrain,
    ) -> std::result::Result<WorkerHandlersProgress, FleetMaintenanceCheckError> {
        self.authorization.interrupt_original_handlers(fence, drain)
    }
    pub fn settle_original_handlers(
        &mut self,
        fence: &PoolTransitionFence,
        drain: &mut WorkerOriginalHandlersDrain,
    ) -> std::result::Result<WorkerHandlersProgress, FleetMaintenanceCheckError> {
        self.authorization.settle_original_handlers(fence, drain)
    }
    pub fn drain_legacy_fleet(
        self,
        broker: &'a Arc<InstallingBroker>,
        fence: PoolTransitionFence,
        closed: WorkerOriginalHandlersClosed,
    ) -> std::result::Result<DrainedPoolMigration<'a>, Box<LegacyFleetDrainFailure<'a>>> {
        self.authorization
            .drain_consuming(broker, fence, closed, FleetMaintenanceAction::MigratePool)
            .map(|fleet| DrainedPoolMigration { fleet })
    }
}
