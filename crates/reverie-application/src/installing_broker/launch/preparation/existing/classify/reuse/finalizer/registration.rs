//! Shared registration effects require fresh allocation authority outside the
//! lifecycle lock and the exact Office owner captured under the original lock.
use super::*;
#[cfg(test)]
fn pause_registration() {
    REGISTRATION_PAUSE.with(|slot| {
        if let Some(pause) = slot.borrow_mut().take() {
            pause.wait(());
        }
    });
}
impl Finalizer<'_> {
    pub(super) fn metadata(&mut self, budget: CleanupBudget) {
        let scope = self.owner.scope();
        let result = budget.metadata(&scope.preparing, scope.active.as_ref());
        if let Err(error) = result {
            self.errors.push(Error::Gate(error));
        }
    }
    pub(super) fn close_registration(&mut self, budget: CleanupBudget) {
        if let Err(error) = self.close_registration_inner(budget) {
            self.errors.push(Error::Gate(error));
        }
    }
    fn close_registration_inner(&self, budget: CleanupBudget) -> Result<(), GateError> {
        let scope = self.owner.scope();
        let broker = scope.preparing.broker();
        let target = self
            .target
            .as_ref()
            .ok_or(GateError::Refused("WORKER_REUSE_TARGET_REQUIRED"))?;
        // Gate -> lifecycle is the original lock order. Never acquire a fresh
        // allocation flock while holding the application lifecycle mutex.
        let admission = scope.preparing.admit_original_cleanup(target)?;
        let body = (|| {
            admission.assert_broker(broker)?;
            admission.assert_target(target)?;
            #[cfg(test)]
            pause_registration();
            let mut lifecycle = budget.lifecycle(broker)?;
            let token = scope
                .active
                .as_ref()
                .ok_or(GateError::Refused("WORKER_REUSE_ACTIVE_REQUIRED"))?;
            let closed = match budget {
                CleanupBudget::Bounded(end) => lifecycle.close_reuse_registration(
                    token,
                    target,
                    scope.registration.as_ref(),
                    end,
                ),
                CleanupBudget::Worker => lifecycle.close_reuse_registration_for_worker(
                    token,
                    target,
                    scope.registration.as_ref(),
                ),
            };
            closed.map_err(|error| GateError::OriginalSource(Box::new(error)))
        })();
        let closed = if body.is_ok() {
            admission.close()
        } else {
            admission.abort()
        };
        crate::reservation_gate::finalized(body, closed)
    }
}
