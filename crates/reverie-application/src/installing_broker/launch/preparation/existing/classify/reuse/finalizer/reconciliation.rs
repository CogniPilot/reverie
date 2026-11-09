//! Same-handler bookkeeping continuation. The original native/storage phases
//! are not retried and no uncertain stop/Office outcome is reset.
use super::*;
impl<'a> ReuseFinalizationFailure<'a> {
    pub(in crate::installing_broker) fn reconcile_handler(
        mut self: Box<Self>,
    ) -> Result<ReuseHandlerClosed, Box<Self>> {
        if matches!(self.owner, Owner::Classified(_)) {
            return self.reconcile_classified();
        }
        let Some((completed, storage_retained)) = self.bookkeeping else {
            if let Owner::Native { retained, .. } = &self.owner
                && let Err(error) = retained.native.settle_handler_native()
            {
                self.errors.push(Error::Storage(error));
            }
            return Err(self);
        };
        let budget = CleanupBudget::Worker;
        if let Err(error) = budget.close_request(&self.owner.scope().preparing.admitted.request) {
            self.errors.push(Error::Transport(error));
            return Err(self);
        }
        if let Some(token) = &mut self.owner.scope_mut().active
            && let Err(error) = budget.release_hold(token)
        {
            self.errors.push(Error::Transport(error));
            return Err(self);
        }
        Ok(ReuseHandlerClosed {
            completed,
            storage_retained,
            primary: self.primary,
            history: self.errors,
            classified: None,
        })
    }
    fn reconcile_classified(self: Box<Self>) -> Result<ReuseHandlerClosed, Box<Self>> {
        let Self {
            owner,
            primary,
            errors,
            ..
        } = *self;
        let Owner::Classified(owner) = owner else {
            unreachable!("actual classified owner");
        };
        match owner.reconcile_handler() {
            Ok(closed) => Ok(ReuseHandlerClosed {
                completed: closed.completed(),
                storage_retained: closed.storage_retained(),
                primary,
                history: errors,
                classified: Some(closed),
            }),
            Err(owner) => Err(Box::new(Self {
                owner: Owner::Classified(owner),
                primary,
                errors,
                bookkeeping: None,
            })),
        }
    }
}
