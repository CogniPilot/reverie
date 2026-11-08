//! Continue ONLY after the original resource phases actually finished. Earlier
//! native/observation/effect failures remain retained; this never reruns finish.
use super::*;
impl<'a> ColdFinalizationFailure<'a> {
    pub(in crate::installing_broker) fn reconcile_handler(
        mut self: Box<Self>,
    ) -> Result<ColdHandlerClosed, Box<Self>> {
        let Some(storage_retained) = self.cleanup.bookkeeping else {
            // Only original retained native work is polled. Even known local
            // settlement cannot erase an earlier effect/observation failure.
            self.cleanup.settle_original_native();
            return Err(self);
        };
        let budget = CleanupBudget::Worker;
        let scope = self.cleanup.owner.scope();
        if let Err(error) = budget.close_request(&scope.preparing.admitted.request) {
            self.cleanup.errors.push(error.into());
            return Err(self);
        }
        if let Some(token) = &mut self.cleanup.owner.scope_mut().active
            && let Err(error) = budget.release_hold(token)
        {
            self.cleanup.errors.push(error.into());
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
impl Finalizer<'_> {
    fn settle_original_native(&mut self) {
        let result: Result<(), ColdError> = match self.resource() {
            Some(Resources::CopyingNix(input)) => input
                .preparation
                .settle_handler_native()
                .map(|_| ())
                .map_err(Into::into),
            _ => self.owner.network().map_or(Ok(()), |network| {
                network
                    .settle_handler_native()
                    .map(|_| ())
                    .map_err(Into::into)
            }),
        };
        if let Err(error) = result {
            self.errors.push(error);
        }
    }
}
