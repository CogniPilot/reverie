//! Only the original admitted native producer can mint these publication
//! proofs. Snapshot and policy accessors expose data, never reconstruction.
use super::*;
use crate::installing_broker::resource_actor::{DrainedPoolMigration, FleetMaintenanceCheckError};
use reverie_contracts::worker_pool::WorkerPoolConfigurationTransition;
use reverie_host::{
    reservation_control::{PoolPublication, PoolTerminal},
    resource_facts::ActorRebindPlan,
    worker_pool::ActivatedController,
    worker_runtime::WorkerStopBudget,
};
mod commit;
mod finish;
mod prepare;

pub(super) struct PublishedConfiguration {
    before: Arc<ValidatedWorkerSnapshot>,
    after: Arc<ValidatedWorkerSnapshot>,
    binding: ControlBinding,
}

pub(crate) struct PublishedPool {
    _record: Arc<TransitionRecord>,
    configuration: Arc<PublishedConfiguration>,
    budget: WorkerStopBudget,
    end: Instant,
}

struct PublicationAttempt {
    gate: Arc<Inner>,
    broker: Arc<crate::installing_broker::InstallingBroker>,
    record: Arc<TransitionRecord>,
    configuration: Arc<PublishedConfiguration>,
    transition: Arc<WorkerPoolConfigurationTransition>,
    actor: Option<ActorRebindPlan>,
    budget: WorkerStopBudget,
    end: Instant,
    admission: Option<admission::Admission>,
    native: Option<PoolPublication>,
}

impl ReservationGate {
    pub(crate) fn publish_drained_pool(
        &self,
        migration: &mut DrainedPoolMigration<'_>,
        controller: &mut Option<ActivatedController>,
    ) -> Result<PoolMigrationPublished> {
        let mut attempt = PublicationAttempt::prepare(self, migration)?;
        match attempt.publish(self, migration, controller) {
            Ok(terminal) => attempt.close_and_release(self, migration, terminal),
            Err(primary) => attempt.fail(primary),
        }
    }
}

fn authorize<T>(
    migration: &mut DrainedPoolMigration<'_>,
    result: std::result::Result<T, FleetMaintenanceCheckError>,
) -> Result<T> {
    result.map_err(|error| migration.retain_publication_failure(error))
}

fn live(migration: &mut DrainedPoolMigration<'_>, gate: &ReservationGate) -> Result<()> {
    let checked = migration.assert_publication_live(gate);
    authorize(migration, checked)
}

impl PublicationAttempt {
    fn fail<T>(mut self, primary: GateError) -> Result<T> {
        let closed = self
            .admission
            .take()
            .map_or(Ok(()), admission::Admission::abort);
        finalized(Err(primary), closed)
    }
}

impl PublishedPool {
    pub(crate) fn deadline(&self) -> Instant {
        self.budget
            .deadline()
            .map_or(self.end, |stop| self.end.min(stop))
    }

    pub(crate) fn assert_live(&self) -> Result<()> {
        need(
            Instant::now() < self.deadline(),
            "POOL_PUBLICATION_DEADLINE",
        )
    }

    pub(crate) fn parts(
        &self,
    ) -> (
        &Arc<ValidatedWorkerSnapshot>,
        &Arc<ValidatedWorkerSnapshot>,
        &ControlBinding,
    ) {
        (
            &self.configuration.before,
            &self.configuration.after,
            &self.configuration.binding,
        )
    }
}

/// Minted only after checked native terminal release. A configured parent is
/// distinct from subsequent worker readiness, which must be observed afresh.
pub(crate) struct PoolMigrationPublished {
    transition: Arc<WorkerPoolConfigurationTransition>,
}

impl PoolMigrationPublished {
    pub(crate) fn transition(&self) -> &WorkerPoolConfigurationTransition {
        &self.transition
    }
}

impl TransitionRecord {
    pub(super) fn assert_live_configuration(&self, gate: &Inner) -> Result<()> {
        let published = self
            .published
            .lock()
            .map_err(|_| GateError::Refused("POOL_PUBLICATION_REQUIRES_RECONCILIATION"))?;
        match published.as_ref() {
            None => self
                .intent
                .assert_configuration(gate.config()?.configuration())
                .map_err(Into::into),
            Some(published) => need(
                Arc::ptr_eq(&gate.installed.snapshot()?, &published.after),
                "POOL_PUBLICATION_CONFIGURATION_CHANGED",
            ),
        }
    }
}
