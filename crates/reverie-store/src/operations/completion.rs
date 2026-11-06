use super::*;
/// Sealed dependency seam for the not-yet-ported actual native finalization
/// producer. Production has no constructor, callback, JSON or digest mint.
/// Future application-owned finalization must preserve pending markers, exact
/// live owner/readiness and kernel fences; it must not move into this store.
///
/// ```compile_fail
/// use reverie_store::operations::NativeCompletionProof;
/// let proof=NativeCompletionProof {};
/// ```
pub struct NativeCompletionProof {
    source: Source,
}
#[cfg_attr(not(test), derive(Clone, Copy))]
enum Source {
    #[cfg(test)]
    Fixture(Fixture),
}
impl NativeCompletionProof {
    pub(super) fn assert_current(
        &self,
        store: &OperationStore,
        scope: &OperationScope,
        op: &Operation,
    ) -> Result<JournalDigest> {
        #[cfg(not(test))]
        {
            let _ = (store, scope, op);
            match self.source {}
        }
        #[cfg(test)]
        match &self.source {
            #[cfg(test)]
            Source::Fixture(fixture) => {
                need(
                    Arc::ptr_eq(&fixture.store, &store.identity)
                        && fixture.scope == *scope
                        && fixture.operation == *op,
                    "RESOURCE_COMPLETION_PRODUCER_REQUIRED",
                )?;
                (fixture.fence)()?;
                Ok(fixture.digest.clone())
            }
        }
    }
}
#[cfg(test)]
struct Fixture {
    store: Arc<()>,
    scope: OperationScope,
    operation: Operation,
    digest: JournalDigest,
    fence: Box<dyn Fn() -> Result<()>>,
}
#[cfg(test)]
pub(super) fn fixture(
    store: &OperationStore,
    scope: OperationScope,
    operation: Operation,
    digest: JournalDigest,
    fence: impl Fn() -> Result<()> + 'static,
) -> NativeCompletionProof {
    NativeCompletionProof {
        source: Source::Fixture(Fixture {
            store: store.identity.clone(),
            scope,
            operation,
            digest,
            fence: Box::new(fence),
        }),
    }
}
