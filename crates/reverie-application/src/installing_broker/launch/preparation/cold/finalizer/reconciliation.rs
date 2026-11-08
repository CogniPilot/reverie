//! Continue ONLY after the original resource phases actually finished. Earlier
//! native/observation/effect failures remain retained; this never reruns finish.
use super::*;
use crate::installing_broker::launch::preparation::finalization::retain_late_error;
impl<'a> ColdFinalizationFailure<'a> {
    pub(in crate::installing_broker) fn reconcile_handler(
        mut self: Box<Self>,
    ) -> Result<ColdHandlerClosed, Box<Self>> {
        let Some(storage_retained) = self.cleanup.bookkeeping else {
            // Only original retained native work is polled. Even known local
            // settlement cannot erase an earlier effect/observation failure.
            if let Some(network) = self.cleanup.owner.network()
                && let Err(error) = network.settle_handler_native()
            {
                retain_late_error(&mut self.cleanup.errors, error.into());
            }
            return Err(self);
        };
        let budget = CleanupBudget::Worker;
        let scope = self.cleanup.owner.scope();
        if let Err(error) = budget.close_request(&scope.preparing.admitted.request) {
            retain_late_error(&mut self.cleanup.errors, error.into());
            return Err(self);
        }
        if let Some(token) = &mut self.cleanup.owner.scope_mut().active
            && let Err(error) = budget.release_hold(token)
        {
            retain_late_error(&mut self.cleanup.errors, error.into());
            return Err(self);
        }
        let mut cleanup = self.cleanup;
        // Keep historical cleanup failures as negative diagnostics even when
        // actual same-record bookkeeping can now finish. Opaque FD outcomes
        // cannot pass the original close/hold checks above.
        cleanup.body_causes.append(&mut cleanup.errors);
        Ok(ColdHandlerClosed {
            completed: cleanup.completed.expect("actual original receipt phase"),
            storage_retained,
            primary: cleanup.primary,
            body_causes: cleanup.body_causes,
        })
    }
}
