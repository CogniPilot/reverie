//! Every body/constructor/relay outcome consumes its whole original handler.
//! Native or resource uncertainty stays in ColdFinalizationFailure.
use super::*;

impl<'a> AllocationClosedCold<'a> {
    pub fn finalize(
        self,
        end: Instant,
    ) -> Result<ColdHandlerClosed, Box<ColdFinalizationFailure<'a>>> {
        finish(Owner::Closed(self), None, CleanupBudget::Bounded(end))
    }
    pub fn finalize_for_worker(
        self,
    ) -> Result<ColdHandlerClosed, Box<ColdFinalizationFailure<'a>>> {
        finish(Owner::Closed(self), None, CleanupBudget::Worker)
    }
}
impl<'a> ViewingCold<'a> {
    pub fn finalize(
        self,
        end: Instant,
    ) -> Result<ColdHandlerClosed, Box<ColdFinalizationFailure<'a>>> {
        finish(Owner::Viewing(self), None, CleanupBudget::Bounded(end))
    }
    pub fn finalize_for_worker(
        self,
    ) -> Result<ColdHandlerClosed, Box<ColdFinalizationFailure<'a>>> {
        finish(Owner::Viewing(self), None, CleanupBudget::Worker)
    }
}
impl<'a> ColdLaunchFailure<'a> {
    pub fn finalize(
        self: Box<Self>,
        end: Instant,
    ) -> Result<ColdHandlerClosed, Box<ColdFinalizationFailure<'a>>> {
        let Self { owner, cause } = *self;
        finish(
            Owner::Body(Box::new(owner)),
            Some(cause),
            CleanupBudget::Bounded(end),
        )
    }
    pub fn finalize_for_worker(
        self: Box<Self>,
    ) -> Result<ColdHandlerClosed, Box<ColdFinalizationFailure<'a>>> {
        let Self { owner, cause } = *self;
        finish(
            Owner::Body(Box::new(owner)),
            Some(cause),
            CleanupBudget::Worker,
        )
    }
}
impl<'a> ColdViewerFailure<'a> {
    pub fn finalize(
        self: Box<Self>,
        end: Instant,
    ) -> Result<ColdHandlerClosed, Box<ColdFinalizationFailure<'a>>> {
        let Self { owner, cause } = *self;
        finish(
            Owner::Closed(owner),
            Some(cause),
            CleanupBudget::Bounded(end),
        )
    }
    pub fn finalize_for_worker(
        self: Box<Self>,
    ) -> Result<ColdHandlerClosed, Box<ColdFinalizationFailure<'a>>> {
        let Self { owner, cause } = *self;
        finish(Owner::Closed(owner), Some(cause), CleanupBudget::Worker)
    }
}
