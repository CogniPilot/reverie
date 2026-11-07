//! Consume the actual prefix failure only when its original cleanup owners
//! were captured. Missing owners and later classified aborts stay retained.
use super::*;

impl<'a> PreparationFailure<'a> {
    pub fn finalize(
        self: Box<Self>,
        end: Instant,
    ) -> Result<ColdHandlerClosed, Box<ColdFinalizationFailure<'a>>> {
        self.finalize_prefix(CleanupBudget::Bounded(end))
    }
    pub fn finalize_for_worker(
        self: Box<Self>,
    ) -> Result<ColdHandlerClosed, Box<ColdFinalizationFailure<'a>>> {
        self.finalize_prefix(CleanupBudget::Worker)
    }
    fn original_running(&self) -> Option<bool> {
        if self.transport_attempted
            || !self.cleanup.is_empty()
            || !matches!(self.origin, FailureOrigin::Prefix)
            || !matches!(self.registration, FailureRegistration::Captured(_))
            || self.storage.is_none()
            || self.active.is_none()
            || self.current.is_none()
            || self.observed.is_none()
        {
            return None;
        }
        self.observation
            .as_ref()?
            .previous
            .as_ref()?
            .data()
            .running()
            .ok()
    }
    fn finalize_prefix(
        mut self: Box<Self>,
        budget: CleanupBudget,
    ) -> Result<ColdHandlerClosed, Box<ColdFinalizationFailure<'a>>> {
        let Some(running) = self.original_running() else {
            // Checked local finalizers do not establish physical resource or
            // counted-Hold release. Never replay an earlier uncertain attempt.
            self.close_transport_budget(budget);
            return Err(ColdFinalizationFailure::retained_preparation(self));
        };
        let Self {
            preparing,
            storage,
            active,
            observed,
            current,
            cause,
            observation,
            registration,
            ..
        } = *self;
        let FailureObservation {
            plan,
            previous,
            receipt,
        } = observation.expect("same genuine complete observation");
        let FailureRegistration::Captured(registration) = registration else {
            unreachable!("checked original lifecycle capture");
        };
        let resources = plan.effective_configuration().clone();
        let owner = ClassifiedCleanup {
            scope: ColdScope {
                preparing,
                active,
                observed: observed.expect("original wait owner"),
                current: current.expect("original observed source"),
                resources,
                receipt,
                registration,
                original: if running {
                    OriginalRuntime::Running
                } else {
                    OriginalRuntime::Stopped
                },
                // Only actual Prefix producers reach this branch. A classified
                // abort has a distinct origin and cannot infer this phase.
                budget: CreationBudget::Unconfirmed,
            },
            lifecycle: None,
            resources: Some(Resources::OriginalCleanup {
                storage: storage.expect("same actual original claim"),
                plan,
                inspection: previous.expect("same sealed first inspection"),
            }),
        };
        finish(
            Owner::Classified(Box::new(owner)),
            Some(cause.into()),
            budget,
        )
    }
}
