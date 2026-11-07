//! Actual Office producers close under fresh stop admission and the same
//! lifecycle registration. Idle-now never permits releasing their storage.
use super::*;
impl Finalizer<'_> {
    pub(super) fn metadata(&mut self, budget: CleanupBudget) {
        let scope = self.owner.scope();
        if let Err(error) = budget.metadata(&scope.preparing, scope.active.as_ref()) {
            self.errors.push(error.into());
        }
    }
    pub(super) fn close_direct_offices(&mut self, live: bool, budget: CleanupBudget) {
        if live || !self.errors.is_empty() {
            return;
        }
        let Some(completed) = self.completed else {
            return;
        };
        if !self.owner.remove_registration(completed) {
            if self.owner.scope().registration.is_some() {
                self.errors
                    .push(ColdError::Refused("WORKER_COLD_OFFICE_RETAINED"));
            }
            return;
        }
        if let Err(error) = self.close_offices_under_scope(budget) {
            self.errors.push(error);
        }
    }
    fn close_offices_under_scope(&self, budget: CleanupBudget) -> Result<(), ColdError> {
        let scope = self.owner.scope();
        let broker = scope.preparing.broker();
        let target = self
            .target
            .as_ref()
            .ok_or(ColdError::Refused("WORKER_COLD_STOP_TARGET_REQUIRED"))?;
        let admission = broker.admit_ordinary_stop(target)?;
        let body = (|| {
            admission.assert_broker(broker)?;
            admission.assert_target(target)?;
            let mut lifecycle = budget.lifecycle(broker)?;
            let active = scope
                .active
                .as_ref()
                .ok_or(ColdError::Refused("WORKER_COLD_ACTIVE_REQUIRED"))?;
            let original = self
                .owner
                .started()
                .map(|started| &started.office)
                .or(scope.registration.as_ref());
            match budget {
                CleanupBudget::Bounded(end) => {
                    lifecycle.close_reuse_registration(active, target, original, end)?
                }
                CleanupBudget::Worker => {
                    lifecycle.close_reuse_registration_for_worker(active, target, original)?
                }
            }
            // A genuinely new phone was never published to a registration.
            // An original alias shares the already-closed native owner and
            // supplies no second close attempt or independent close credit.
            if original.is_none()
                && let Owner::Body(owner) = &self.owner
            {
                if let Some(office) = &owner.office {
                    office.close_for_stopped_source(budget.phase(2_000))?;
                }
                if let Some((office, construction)) = &owner.construction {
                    office.close_construction(construction, budget.phase(2_000))?;
                }
            }
            Ok(())
        })();
        let closed = if body.is_ok() {
            admission.close()
        } else {
            admission.abort()
        };
        match (body, closed) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(primary), Ok(())) => Err(primary),
            (Ok(()), Err(cause)) => Err(cause.into()),
            (Err(primary), Err(secondary)) => Err(error::finalized(primary, secondary.into())),
        }
    }
}
