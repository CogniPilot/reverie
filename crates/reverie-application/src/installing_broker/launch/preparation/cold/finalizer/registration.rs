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
            let unregistered = matches!(&self.owner, Owner::Body(owner)
                if owner.office.is_some() || owner.construction.is_some() || owner.network_phone.is_some());
            if self.owner.scope().registration.is_some()
                || self.owner.started().is_some()
                || unregistered
            {
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
        let admission = scope.preparing.admit_original_cleanup(target)?;
        let body = (|| {
            admission.assert_broker(broker)?;
            admission.assert_target(target)?;
            let mut lifecycle = budget.lifecycle(broker)?;
            let active = scope
                .active
                .as_ref()
                .ok_or(ColdError::Refused("WORKER_COLD_ACTIVE_REQUIRED"))?;
            let reused = match &self.owner {
                Owner::Body(owner) => match &owner.office {
                    Some(ColdOffice::Retained { original, .. }) => Some(original),
                    _ => None,
                },
                _ => None,
            };
            let original = self
                .owner
                .started()
                .map(|started| &started.office)
                .or(reused)
                .or(scope.registration.as_ref());
            let registration = match budget {
                CleanupBudget::Bounded(end) => {
                    lifecycle.close_reuse_registration(active, target, original, end)
                }
                CleanupBudget::Worker => {
                    lifecycle.close_reuse_registration_for_worker(active, target, original)
                }
            }
            .map_err(ColdError::from);
            self.close_body_producers(registration, budget)?;
            self.require_office_closure()
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
    fn close_body_producers(
        &self,
        registration: Result<(), ColdError>,
        budget: CleanupBudget,
    ) -> Result<(), ColdError> {
        let Owner::Body(owner) = &self.owner else {
            return registration;
        };
        // Constructor provenance distinguishes a new producer from an alias.
        // Attempt every actual close even when an earlier close failed.
        let mut closed = registration;
        if self.owner.started().is_none()
            && let Some(ColdOffice::Constructed(office)) = &owner.office
        {
            let next = office
                .close_for_stopped_source(budget.phase(2_000))
                .map_err(ColdError::from);
            closed = combine(closed, next);
        }
        if let Some((office, construction)) = &owner.construction {
            let next = office
                .close_construction(construction, budget.phase(2_000))
                .map_err(ColdError::from);
            closed = combine(closed, next);
        }
        closed
    }
    fn require_office_closure(&self) -> Result<(), ColdError> {
        let scope = self.owner.scope();
        let runtime = &scope.preparing.broker().storage.runtime;
        let session = scope.preparing.admitted.request().session();
        if let Owner::Body(owner) = &self.owner {
            if let Some(office) = &owner.office {
                office
                    .owner()
                    ._phone
                    .require_closed_for_resource(runtime, session)?;
            }
            if let Some(phone) = &owner.predecessor_phone {
                phone.require_closed_for_resource(runtime, session)?;
            }
            if let Some(phone) = &owner.network_phone {
                phone.require_closed_for_resource(runtime, session)?;
            }
        }
        if let Some(phone) = &self.predecessor_phone {
            phone.require_closed_for_resource(runtime, session)?;
        }
        if let Some(original) = &scope.registration {
            original
                ._phone
                .require_closed_for_resource(runtime, session)?;
        }
        Ok(())
    }
}
fn combine(
    primary: Result<(), ColdError>,
    secondary: Result<(), ColdError>,
) -> Result<(), ColdError> {
    match (primary, secondary) {
        (Ok(()), next) | (next, Ok(())) => next,
        (Err(primary), Err(secondary)) => Err(error::finalized(primary, secondary)),
    }
}
