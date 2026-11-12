use super::*;

impl PublicationAttempt {
    pub(super) fn prepare(
        gate: &ReservationGate,
        migration: &mut DrainedPoolMigration<'_>,
    ) -> Result<Self> {
        let checked = migration.assert_publication_current(gate);
        authorize(migration, checked)?;
        let broker = Arc::clone(migration.publication_broker());
        need(
            broker
                .resource_reservations()?
                .is_some_and(|original| std::ptr::eq(original, gate)),
            "POOL_PUBLICATION_BROKER_CHANGED",
        )?;
        let before = Arc::clone(migration.original_snapshot());
        need(
            Arc::ptr_eq(&before, &gate.inner.installed.snapshot()?),
            "POOL_PUBLICATION_CONFIGURATION_CHANGED",
        )?;
        let binding = gate
            .inner
            .binding
            .read()
            .map_err(|_| GateError::Refused("RESERVATION_ADMISSION_UNAVAILABLE"))?
            .clone();
        let candidate = migration.configuration_transition(&binding);
        let transition = authorize(migration, candidate)?;
        let after = Arc::new(before.validate_pool_candidate(&transition)?);
        let checked = migration.assert_publication_current(gate);
        authorize(migration, checked)?;
        let actor = migration.prepare_actor_rebind(&transition);
        let actor = authorize(migration, actor)?;
        let budget = migration.publication_budget();
        let end = budget
            .deadline()
            .map_or(migration.original_deadline(), |stop| {
                stop.min(migration.original_deadline())
            });
        let fence = migration.publication_fence();
        fence.assert_gate(gate)?;
        fence.assert_selection(migration.selection())?;
        let record = Arc::clone(&fence.record);
        let purpose = fence.pool_publication()?;
        let admission = gate.inner.admit_transition_entry(purpose, &budget, end)?;
        let attempt = Self {
            gate: Arc::clone(&gate.inner),
            broker,
            record,
            configuration: Arc::new(PublishedConfiguration {
                before,
                after,
                binding: transition.after_binding().clone(),
            }),
            transition,
            actor: Some(actor),
            budget,
            end,
            admission: Some(admission),
            native: None,
        };
        match attempt.assert_admitted(gate, migration) {
            Ok(()) => Ok(attempt),
            Err(primary) => attempt.fail(primary),
        }
    }

    pub(super) fn assert_admitted(
        &self,
        gate: &ReservationGate,
        migration: &mut DrainedPoolMigration<'_>,
    ) -> Result<()> {
        live(migration, gate)?;
        self.gate
            .held(None)?
            .original_cleanup
            .as_ref()
            .ok_or(GateError::Refused("POOL_PUBLICATION_ADMISSION_REQUIRED"))?
            .assert_fleet_history(&self.gate)?;
        need(
            Arc::ptr_eq(&self.gate.installed.snapshot()?, &self.configuration.before),
            "POOL_PUBLICATION_CONFIGURATION_CHANGED",
        )?;
        self.gate.guard(None)?;
        live(migration, gate)
    }
}
