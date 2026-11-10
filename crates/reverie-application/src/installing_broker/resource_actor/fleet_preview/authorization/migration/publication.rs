//! Phase-correct authorization after actual J/native fleet closure. The old
//! registry/native census is not reinterpreted as unchanged after the drain.
use super::*;
use crate::reservation_gate::{PublishedPool, ReservationGate};

impl DrainedPoolMigration<'_> {
    pub(crate) fn prepare_actor_rebind(
        &mut self,
        transition: &reverie_contracts::worker_pool::WorkerPoolConfigurationTransition,
    ) -> std::result::Result<
        reverie_host::resource_facts::ActorRebindPlan,
        FleetMaintenanceCheckError,
    > {
        let preview = &mut self
            .fleet
            .owner
            .as_mut()
            .expect("original fleet")
            .authorization
            .owner;
        let frame = preview.frame.as_mut().expect("same original Q");
        let body = (|| {
            let snapshot = frame.snapshot.as_ref().expect("original snapshot");
            if !reverie_contracts::worker_config::equivalent(
                snapshot.configuration(),
                transition.before(),
            ) {
                return Err(Cause::Refused("POOL_MIGRATION_ACTOR_CONFIGURATION_CHANGED"));
            }
            frame
                .private
                .prepare_configuration_rebind(transition.before(), transition.after())
                .map_err(ResourceActorError::from)
                .map_err(Into::into)
        })();
        preview.retain_check(body)
    }
    pub(crate) fn retain_publication_failure(
        &mut self,
        error: FleetMaintenanceCheckError,
    ) -> GateError {
        let code = error.code();
        self.fleet
            .owner
            .as_mut()
            .expect("original fleet")
            .authorization
            .owner
            .primary
            .get_or_insert(error.cause);
        GateError::Refused(code)
    }
    pub(crate) fn publication_fence(&self) -> &PoolTransitionFence {
        &self.fleet.owner.as_ref().expect("original fleet").fence
    }
    pub(crate) fn publication_broker(&self) -> &Arc<InstallingBroker> {
        self.fleet.owner.as_ref().expect("original fleet").broker
    }
    pub(crate) fn publication_budget(&self) -> reverie_host::worker_runtime::WorkerStopBudget {
        self.publication_broker().storage.runtime.stop_budget()
    }
    pub(crate) fn assert_publication_controller_current(
        &mut self,
        gate: &ReservationGate,
        controller: &mut Option<reverie_host::worker_pool::ActivatedController>,
    ) -> std::result::Result<(), FleetMaintenanceCheckError> {
        self.assert_publication_live(gate)?;
        let owner = self.fleet.owner.as_mut().expect("original fleet");
        let end = owner.authorization.owner.original_end();
        let body = controller
            .as_mut()
            .ok_or(Cause::Refused("POOL_MIGRATION_CONTROLLER_REQUIRED"))
            .and_then(|controller| {
                controller
                    .assert_current(&owner.broker.storage.runtime, end)
                    .map_err(Cause::Pool)
            });
        owner.authorization.owner.retain_check(body)
    }
    pub(crate) fn configuration_transition(
        &mut self,
        binding: &reverie_contracts::reservation_control::ControlBinding,
    ) -> std::result::Result<
        Arc<reverie_contracts::worker_pool::WorkerPoolConfigurationTransition>,
        FleetMaintenanceCheckError,
    > {
        let owner = self.fleet.owner.as_mut().expect("original fleet");
        let preview = &mut owner.authorization.owner;
        let body = (|| {
            let policy = preview
                .target
                .as_mut()
                .expect("original target")
                .current()?;
            let coverage = preview.coverage.as_ref().expect("original company");
            let sessions = coverage.session_employees()?;
            let before = preview
                .frame
                .as_ref()
                .expect("same Q")
                .snapshot
                .as_ref()
                .expect("original snapshot");
            reverie_contracts::worker_pool::WorkerPoolConfigurationTransition::prepare(
                before.configuration(),
                policy.policy(),
                binding,
                &sessions,
            )
            .map(Arc::new)
            .map_err(Cause::PoolConfiguration)
        })();
        preview.retain_check(body)
    }
    pub(crate) fn original_snapshot(&self) -> &Arc<ValidatedWorkerSnapshot> {
        self.fleet
            .owner
            .as_ref()
            .expect("original fleet")
            .authorization
            .owner
            .frame
            .as_ref()
            .expect("same Q")
            .snapshot
            .as_ref()
            .expect("original snapshot")
    }
    pub fn selection(&self) -> &reverie_contracts::reservation_control::PoolTransitionSelection {
        self.fleet.selection()
    }
    pub fn original_deadline(&self) -> Instant {
        self.fleet
            .owner
            .as_ref()
            .expect("original fleet")
            .authorization
            .owner
            .original_end()
    }
    pub(crate) fn assert_publication_current(
        &mut self,
        gate: &ReservationGate,
    ) -> std::result::Result<(), FleetMaintenanceCheckError> {
        self.assert_publication_origin(gate)?;
        let owner = self.fleet.owner.as_mut().expect("original fleet");
        let preview = &mut owner.authorization.owner;
        let body = (|| {
            let end = preview.original_end();
            preview
                .frame
                .as_mut()
                .expect("same Q")
                .guard_bootstrap(end)?;
            preview
                .coverage
                .as_ref()
                .expect("original company")
                .read_current_company(preview.frame.as_mut().expect("same Q"))?;
            preview.assert_binding()?;
            preview.assert_inputs_current()?;
            preview.refresh_maintenance_owner()?;
            preview.assert_binding()?;
            preview.assert_inputs_current()?;
            preview.assert_maintenance_live()
        })();
        preview.retain_check(body)
    }
    pub(crate) fn assert_publication_live(
        &self,
        gate: &ReservationGate,
    ) -> std::result::Result<(), FleetMaintenanceCheckError> {
        self.assert_publication_origin(gate)?;
        let owner = self.fleet.owner.as_ref().expect("original fleet");
        owner
            .authorization
            .check_result(owner.authorization.owner.assert_maintenance_live())
    }
    fn assert_publication_origin(
        &self,
        gate: &ReservationGate,
    ) -> std::result::Result<(), FleetMaintenanceCheckError> {
        self.assert_publication_selection(gate)?;
        let owner = self.fleet.owner.as_ref().expect("original fleet");
        owner
            .authorization
            .check_result(owner.authorization.owner.assert_preview_live())
    }
    pub(super) fn assert_publication_selection(
        &self,
        gate: &ReservationGate,
    ) -> std::result::Result<(), FleetMaintenanceCheckError> {
        let owner = self.fleet.owner.as_ref().expect("original fleet");
        let checked = (|| {
            owner
                .drain
                .assert_drained()
                .map_err(|cause| Cause::Refused(cause.code()))?;
            owner.fence.assert_gate(gate)?;
            owner
                .fence
                .assert_selection(owner.authorization.selection())?;
            owner
                .authorization
                .assert_interrupted_selection(&owner.fence, &owner.handlers.cleanup_binding())?;
            if owner
                .authorization
                .owner
                .maintenance_request
                .as_ref()
                .expect("actual consent")
                .action()
                != FleetMaintenanceAction::MigratePool
            {
                return Err(Cause::Refused("POOL_MIGRATION_CONSENT_REQUIRED"));
            }
            Ok(())
        })();
        owner.authorization.check_result(checked)
    }
    /// Advance this original frame only from Gate's actual paired-publication
    /// proof, after the atomic App tuple install. No DATA snapshot setter exists.
    pub(crate) fn accept_published_configuration(
        &mut self,
        proof: &PublishedPool,
        actor: &reverie_host::resource_facts::ActorRebound,
    ) -> std::result::Result<(), FleetMaintenanceCheckError> {
        let owner = self.fleet.owner.as_mut().expect("original fleet");
        let (before, after, _) = proof.parts();
        let frame = owner.authorization.owner.frame.as_mut().expect("same Q");
        let body = (|| {
            if !frame
                .snapshot
                .as_ref()
                .is_some_and(|snapshot| Arc::ptr_eq(snapshot, before))
                || !Arc::ptr_eq(after, &frame.broker.configuration()?)
                || before.source_path() != after.source_path()
            {
                return Err(Cause::Refused("POOL_MIGRATION_PUBLICATION_CHANGED"));
            }
            let context = frame
                .context
                .as_ref()
                .ok_or(Cause::Refused("RESOURCE_ACTOR_NOT_BOUND"))?
                .with_applied_configuration(after.configuration().clone());
            let bindings = frame
                .bindings
                .as_mut()
                .ok_or(Cause::Refused("RESOURCE_ACTOR_NOT_BOUND"))?;
            let installed = frame
                .private
                .accept_configuration_rebind(actor)
                .map_err(ResourceActorError::from)?;
            // Retain the actual newly accepted document before any subsequent
            // validation can fail; the original observer retains its receipt.
            bindings.installed = installed;
            ResourceActorSettings::capture(after.configuration())?
                .require_document(&bindings.installed)?;
            frame.context = Some(context);
            frame.snapshot = Some(Arc::clone(after));
            Ok(())
        })();
        owner.authorization.owner.retain_check(body)
    }
}
