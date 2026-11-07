//! Consumes the whole real reuse prefix only for finally. It never fabricates
//! Cold classification or permits any forward Nix/network/create operation.
use super::*;
use crate::installing_broker::launch::preparation::finalization::CleanupBudget;

impl<'a> ReusableWorkerLaunch<'a> {
    pub fn finalize_classified(
        self,
        end: Instant,
    ) -> Result<ColdHandlerClosed, Box<ColdFinalizationFailure<'a>>> {
        self.finalize_classified_budget(CleanupBudget::Bounded(end))
    }
    pub fn finalize_classified_for_worker(
        self,
    ) -> Result<ColdHandlerClosed, Box<ColdFinalizationFailure<'a>>> {
        self.finalize_classified_budget(CleanupBudget::Worker)
    }
    fn finalize_classified_budget(
        self,
        budget: CleanupBudget,
    ) -> Result<ColdHandlerClosed, Box<ColdFinalizationFailure<'a>>> {
        let ReusableWorkerLaunch { receipt, inspected, resources } = self;
        let InspectedWorkerLaunch { observed, previous } = inspected;
        let observe::ObservedWorkerLaunch { claimed, current, plan } = observed;
        let ClaimedWorkerLaunch {
            preparing, observed, active, lifecycle, mut storage,
        } = claimed;
        let registration = lifecycle.capture_reuse_registration(preparing.admitted.request().session());
        let owner = ClassifiedCleanup {
            scope: ColdScope {
                preparing, observed, active, current, resources, receipt, registration,
                original: OriginalRuntime::Running,
                budget: CreationBudget::Initial,
            },
            lifecycle: Some(lifecycle),
            resources: Some(Resources::OriginalCleanup {
                storage: storage.take().expect("actual classified resource"),
                plan,
                inspection: previous.expect("actual reusable running inspection"),
            }),
        };
        finish(Owner::Classified(Box::new(owner)), None, budget)
    }
}
