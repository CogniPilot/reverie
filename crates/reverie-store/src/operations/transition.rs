use super::*;
use reverie_core::revision::ProfileVersion;
impl OperationStore {
    fn change(
        &self,
        scope: &OperationScope,
        handle: &OperationHandle,
        version: ProfileVersion,
        revoke: bool,
        change: impl FnOnce(&Operation) -> Result<Operation>,
    ) -> Result<OperationView> {
        self.locked(
            scope,
            false,
            revoke.then_some(handle),
            |inner, current, context, lock| {
                need(inner.owns(handle), "MISSING_ACTIVE_CLAIM")?;
                let current = current.expect("existing read");
                let old = current
                    .operations()
                    .get(&handle.id)
                    .ok_or(JournalError::refusal("CLAIM_SCOPE"))?;
                need(old.data().scope == *scope, "CLAIM_SCOPE")?;
                need(old.data().version == version, "STALE_OPERATION_VERSION")?;
                let operation = change(old)?;
                let document = current.replacing(operation.clone())?;
                self.commit(inner, lock, scope, &document, context, None)?;
                Ok(inner.view(&operation))
            },
        )
    }
    pub fn begin_effect(
        &self,
        scope: &OperationScope,
        handle: &OperationHandle,
        effect: Effect,
        expected_version: ProfileVersion,
    ) -> Result<OperationView> {
        self.change(scope, handle, expected_version, false, |op| {
            Ok(op.begin(effect)?)
        })
    }
    pub fn record_ack(
        &self,
        scope: &OperationScope,
        handle: &OperationHandle,
        effect: Effect,
        receipt: JournalDigest,
        expected_version: ProfileVersion,
    ) -> Result<OperationView> {
        self.change(scope, handle, expected_version, false, |op| {
            Ok(op.acknowledge(effect, receipt)?)
        })
    }
    pub fn mark_uncertain(
        &self,
        scope: &OperationScope,
        handle: &OperationHandle,
        expected_version: ProfileVersion,
        reason: RecoveryReason,
    ) -> Result<OperationView> {
        self.change(scope, handle, expected_version, true, |op| {
            Ok(op.uncertain(reason)?)
        })
    }
    pub fn complete_native(
        &self,
        scope: &OperationScope,
        handle: &OperationHandle,
        proof: &NativeCompletionProof,
        expected_version: ProfileVersion,
    ) -> Result<OperationView> {
        self.locked(scope, false, None, |inner, current, context, lock| {
            need(inner.owns(handle), "MISSING_ACTIVE_CLAIM")?;
            let current = current.expect("existing read");
            let old = current
                .operations()
                .get(&handle.id)
                .ok_or(JournalError::refusal("NATIVE_COMPLETION_PHASE"))?;
            need(
                old.data().scope == *scope
                    && old.data().state == OperationState::VerifyRecorded
                    && old.data().version == expected_version
                    && expected_version.get() == 7,
                "NATIVE_COMPLETION_PHASE",
            )?;
            let receipt = proof.assert_current(self, scope, old)?;
            let operation = old.completion_candidate(receipt.clone())?;
            let document = current.replacing(operation.clone())?;
            let fence = || {
                need(
                    proof.assert_current(self, scope, old)? == receipt,
                    "NATIVE_COMPLETION_CHANGED",
                )
            };
            self.commit(inner, lock, scope, &document, context, Some(&fence))?;
            Ok(inner.view(&operation))
        })
    }
}
