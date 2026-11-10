use super::*;

impl PublicationAttempt {
    pub(super) fn close_and_release(
        mut self,
        gate: &ReservationGate,
        migration: &mut DrainedPoolMigration<'_>,
        terminal: PoolTerminal,
    ) -> Result<PoolMigrationPublished> {
        let checked =
            live(migration, gate).and_then(|()| terminal.assert_current().map_err(Into::into));
        if let Err(primary) = checked {
            return self.fail(primary);
        }
        self.admission
            .take()
            .expect("actual publication admission")
            .finish()?;
        terminal.assert_current()?;
        live(migration, gate)?;
        // Keep denial and the actual pending owner locked across LAST native
        // release. No fallible lock acquisition follows a successful unlink.
        let mut transition = self
            .gate
            .pool_transition
            .lock()
            .map_err(|_| GateError::Refused("POOL_PUBLICATION_REQUIRES_RECONCILIATION"))?;
        need(
            transition
                .as_ref()
                .is_some_and(|original| Arc::ptr_eq(original, &self.record)),
            "POOL_PUBLICATION_ORIGINAL_CHANGED",
        )?;
        let mut pending = self
            .record
            .pending
            .lock()
            .map_err(|_| GateError::Refused("POOL_PUBLICATION_REQUIRES_RECONCILIATION"))?;
        let Pending::Published(pending) = &mut *pending else {
            return Err(GateError::Refused("POOL_PUBLICATION_PHASE"));
        };
        terminal.assert_current()?;
        pending.release_terminal(&terminal)?;
        *transition = None;
        Ok(PoolMigrationPublished {
            transition: Arc::clone(&self.transition),
        })
    }
}
