use super::*;
impl OperationStore {
    /// Fixed post-claim integration under this store's canonical reader/flock.
    /// Only the installed observer runs here; callers supply no editor/callback.
    /// The result is document DATA, never a retained handle or effect permit.
    pub fn confirm_claim(
        &self,
        scope: &OperationScope,
        view: &OperationView,
    ) -> Result<OperationDocument> {
        self.locked(scope, false, None, |_, current, _, _| {
            let document = current.expect("existing read");
            let expected = view.record().data();
            let current = document.operations().get(&expected.id).map(|op| op.data());
            // Preserve the original final-check field set. A later phase is not
            // silently rejected here by adding whole-operation equality.
            need(
                current.is_some_and(|op| {
                    op.reserved_sid == expected.reserved_sid
                        && op.scope == *scope
                        && op.request == expected.request
                        && op.reservation_id == expected.reservation_id
                }),
                "RESERVATION_CLAIM_CHANGED",
            )?;
            let observer = self
                .observer
                .as_ref()
                .ok_or(JournalError::refusal("MISSING_CAPACITY_OBSERVER"))?;
            let observed = observer.observe(
                scope,
                &expected.request.pool_id,
                &expected.request.employee_id,
            )?;
            need(
                observed == expected.observation,
                "RESERVATION_APPROVED_PROFILE_CHANGED",
            )?;
            Ok(document)
        })
    }
}
