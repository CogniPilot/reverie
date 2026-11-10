use super::*;

impl PublicationAttempt {
    pub(super) fn publish(
        &mut self,
        gate: &ReservationGate,
        migration: &mut DrainedPoolMigration<'_>,
        controller: &mut Option<ActivatedController>,
    ) -> Result<PoolTerminal> {
        self.assert_admitted(gate, migration)?;
        let checked = migration.assert_publication_controller_current(gate, controller);
        authorize(migration, checked)?;
        self.publish_files(gate, migration)?;
        let proof = PublishedPool {
            _record: Arc::clone(&self.record),
            configuration: Arc::clone(&self.configuration),
            budget: self.budget.clone(),
            end: self.end,
        };
        let actor = self.published_actor_rebind()?;
        let checked = migration.assert_publication_commit_current(gate, &proof, &actor, controller);
        authorize(migration, checked)?;
        self.install(&proof, controller)?;
        let checked = migration.accept_published_configuration(&proof, &actor);
        authorize(migration, checked)?;
        live(migration, gate)?;
        self.gate.guard(None)?;
        self.gate.check_headroom()?;
        let pending = self
            .record
            .pending
            .lock()
            .map_err(|_| GateError::Refused("POOL_PUBLICATION_REQUIRES_RECONCILIATION"))?;
        let Pending::Published(pending) = &*pending else {
            return Err(GateError::Refused("POOL_PUBLICATION_PHASE"));
        };
        Ok(pending.terminal(self.native.as_ref().expect("checked native publication"))?)
    }

    fn publish_files(
        &mut self,
        gate: &ReservationGate,
        migration: &mut DrainedPoolMigration<'_>,
    ) -> Result<()> {
        let source = self
            .configuration
            .before
            .source_path()
            .ok_or(GateError::Refused("POOL_PUBLICATION_SOURCE_REQUIRED"))?;
        let actor = self
            .actor
            .take()
            .ok_or(GateError::Refused("POOL_PUBLICATION_ACTOR_PLAN_REQUIRED"))?;
        let active = self.gate.held(None)?;
        let admission = active
            .lock
            .lock()
            .map_err(|_| GateError::Refused("RESERVATION_ADMISSION_UNAVAILABLE"))?;
        let mut pending = self
            .record
            .pending
            .lock()
            .map_err(|_| GateError::Refused("POOL_PUBLICATION_REQUIRES_RECONCILIATION"))?;
        let Pending::Published(pending) = &mut *pending else {
            return Err(GateError::Refused("POOL_PUBLICATION_PHASE"));
        };
        let prepared = pending.prepare_publication(
            source,
            Arc::clone(&self.transition),
            actor,
            &admission,
            &self.budget,
            self.end,
        )?;
        live(migration, gate)?;
        self.native = Some(pending.publish_prepared(&prepared, &admission)?);
        Ok(())
    }

    fn published_actor_rebind(&self) -> Result<reverie_host::resource_facts::ActorRebound> {
        let pending = self
            .record
            .pending
            .lock()
            .map_err(|_| GateError::Refused("POOL_PUBLICATION_REQUIRES_RECONCILIATION"))?;
        let Pending::Published(pending) = &*pending else {
            return Err(GateError::Refused("POOL_PUBLICATION_PHASE"));
        };
        Ok(pending
            .publication_actor_rebind(self.native.as_ref().expect("checked native publication"))?
            .clone())
    }

    fn install(
        &self,
        proof: &PublishedPool,
        controller: &mut Option<ActivatedController>,
    ) -> Result<()> {
        let active = self.gate.held(None)?;
        let mut context = active
            .context
            .lock()
            .map_err(|_| GateError::Refused("RESERVATION_ADMISSION_UNAVAILABLE"))?;
        let lifecycle = self.gate.installed.pool_lifecycle(proof)?;
        let mut published = self
            .record
            .published
            .lock()
            .map_err(|_| GateError::Refused("POOL_PUBLICATION_REQUIRES_RECONCILIATION"))?;
        need(published.is_none(), "POOL_PUBLICATION_ALREADY_APPLIED")?;
        self.broker.publish_pool(
            proof,
            &lifecycle,
            &mut context,
            &self.gate.binding,
            controller,
        )?;
        *published = Some(Arc::clone(&self.configuration));
        Ok(())
    }
}
