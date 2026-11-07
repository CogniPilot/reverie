use super::*;
enum Confirmation {
    Claim,
    Preparation,
}
impl OperationStore {
    /// Fixed post-claim integration under this store's canonical reader/flock.
    /// Only the installed observer runs here; callers supply no editor/callback.
    /// The result is document DATA, never a retained handle or effect permit.
    pub fn confirm_claim(
        &self,
        scope: &OperationScope,
        view: &OperationView,
    ) -> Result<OperationDocument> {
        self.confirm_selected(scope, view, Confirmation::Claim)
    }
    /// Fixed PREPARING publication observation: the entire selected operation
    /// must match its actual retained view before the installed observer runs.
    /// Unrelated document rows remain DATA, not an extra equality restriction.
    pub fn confirm_preparation(
        &self,
        scope: &OperationScope,
        view: &OperationView,
    ) -> Result<OperationDocument> {
        self.confirm_selected(scope, view, Confirmation::Preparation)
    }
    fn confirm_selected(
        &self,
        scope: &OperationScope,
        view: &OperationView,
        kind: Confirmation,
    ) -> Result<OperationDocument> {
        self.locked(scope, false, None, |_, current, _, _| {
            let document = current.expect("existing read");
            let expected = view.record().data();
            let current = document.operations().get(&expected.id).map(|op| op.data());
            // Preserve the original final-check field set. A later phase is not
            // silently rejected here by adding whole-operation equality.
            let matches = current.is_some_and(|op| match kind {
                Confirmation::Preparation => *op == *expected,
                Confirmation::Claim => {
                    op.reserved_sid == expected.reserved_sid
                        && op.scope == *scope
                        && op.request == expected.request
                        && op.reservation_id == expected.reservation_id
                }
            });
            let (changed, source) = match kind {
                Confirmation::Claim => (
                    "RESERVATION_CLAIM_CHANGED",
                    "RESERVATION_APPROVED_PROFILE_CHANGED",
                ),
                Confirmation::Preparation => (
                    "RESOURCE_PREPARATION_CLAIM_CHANGED",
                    "RESOURCE_PREPARATION_SOURCE_CHANGED",
                ),
            };
            need(matches, changed)?;
            let observer = self
                .observer
                .as_ref()
                .ok_or(JournalError::refusal("MISSING_CAPACITY_OBSERVER"))?;
            let observed = observer.observe(
                scope,
                &expected.request.pool_id,
                &expected.request.employee_id,
            )?;
            need(observed == expected.observation, source)?;
            Ok(document)
        })
    }
}
