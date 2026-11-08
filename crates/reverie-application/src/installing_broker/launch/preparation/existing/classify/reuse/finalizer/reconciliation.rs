//! Same-handler bookkeeping continuation. The original native/storage phases
//! are not retried and no uncertain stop/Office outcome is reset.
use super::*;
use crate::installing_broker::launch::preparation::finalization::retain_late_error;
impl<'a> ReuseFinalizationFailure<'a> {
    pub(in crate::installing_broker) fn reconcile_handler(
        mut self: Box<Self>,
    ) -> Result<ReuseHandlerClosed, Box<Self>> {
        let Some((completed, storage_retained)) = self.bookkeeping else {
            if let Owner::Native { retained, .. } = &self.owner
                && let Err(error) = retained.native.settle_handler_native()
            {
                retain_late_error(&mut self.errors, Error::Storage(error));
            }
            return Err(self);
        };
        let budget = CleanupBudget::Worker;
        if let Err(error) = budget.close_request(&self.owner.scope().preparing.admitted.request) {
            retain_late_error(&mut self.errors, Error::Transport(error));
            return Err(self);
        }
        if let Some(token) = &mut self.owner.scope_mut().active
            && let Err(error) = budget.release_hold(token)
        {
            retain_late_error(&mut self.errors, Error::Transport(error));
            return Err(self);
        }
        Ok(ReuseHandlerClosed {
            completed,
            storage_retained,
            primary: self.primary,
            history: self.errors,
        })
    }
}
