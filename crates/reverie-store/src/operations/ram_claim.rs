//! Move-only RAM claim custody across checked outer admission boundaries.
//! The fixed installing guard's concrete type remains intact. There is no
//! shared mutable guard, handle extractor, directory reopen or data constructor.
use super::*;
use reverie_core::revision::ProfileVersion;

/// Implement only by the trusted installation's concrete RAM-purpose guard.
/// Comparison is metadata-only and must join the same actual operation/Gate
/// with a different actual admission. Ordinary installations refuse by default.
pub trait RamClaimScope: ScopeGuard + 'static {
    fn assert_ram_claim_scope(&self, _scope: &OperationScope) -> Result<()> {
        Err(JournalError::refusal("RAM_JOURNAL_SCOPE_REQUIRED"))
    }
    fn assert_ram_claim_successor(&self, _prior: &Self, _scope: &OperationScope) -> Result<()> {
        Err(JournalError::refusal("RAM_JOURNAL_SCOPE_REQUIRED"))
    }
}
struct Owner<G: RamClaimScope> {
    store: OperationStore,
    handle: OperationHandle,
    guard: Arc<G>,
    scope: OperationScope,
    view: OperationView,
    closed: bool,
    close_error: Option<Arc<JournalError>>,
}
#[must_use = "retain the whole claimed journal until a checked phase transfer"]
pub struct RamClaimJournal<G: RamClaimScope> {
    owner: Option<Box<Owner<G>>>,
}
#[must_use = "the actual handle and directory remain owned between admissions"]
pub struct SuspendedRamClaimJournal<G: RamClaimScope> {
    owner: Option<Box<Owner<G>>>,
}
#[must_use = "failure retains the same native directory, actual handle and first cause"]
pub struct RamClaimJournalFailure<G: RamClaimScope> {
    owner: Option<Box<Owner<G>>>,
    cause: Arc<JournalError>,
}
impl<G: RamClaimScope> Owner<G> {
    fn lease(&self) -> Result<()> {
        need(
            !self.closed && self.close_error.is_none(),
            "RAM_JOURNAL_CLOSED",
        )?;
        let inner = self
            .store
            .inner
            .lock()
            .map_err(|_| JournalError::refusal("LEDGER_UNAVAILABLE"))?;
        need(inner.owns(&self.handle), "MISSING_ACTIVE_CLAIM")
    }
    fn validate(&self) -> Result<()> {
        self.lease()?;
        self.store
            .locked(&self.scope, false, None, |inner, current, _, _| {
                need(inner.owns(&self.handle), "MISSING_ACTIVE_CLAIM")?;
                let current = current.expect("existing claimed journal");
                need(
                    self.view.record().data().scope == self.scope
                        && current.operations().get(&self.handle.id) == Some(self.view.record()),
                    "RAM_JOURNAL_PHASE_CHANGED",
                )
            })
    }
    fn close_component(&mut self) -> std::result::Result<(), Arc<JournalError>> {
        if let Some(cause) = &self.close_error {
            return Err(cause.clone());
        }
        if self.closed {
            return Ok(());
        }
        // Latch before the consuming native close. An uncertain close cannot
        // become a later empty-directory success or another close attempt.
        self.closed = true;
        self.store.close().map_err(|cause| {
            let cause = Arc::new(cause);
            self.close_error = Some(cause.clone());
            cause
        })
    }
}
fn failure<G: RamClaimScope>(
    owner: Box<Owner<G>>,
    cause: JournalError,
) -> Box<RamClaimJournalFailure<G>> {
    Box::new(RamClaimJournalFailure {
        owner: Some(owner),
        cause: Arc::new(cause),
    })
}
impl<G: RamClaimScope> RamClaimJournal<G> {
    pub fn retain(
        store: OperationStore,
        handle: OperationHandle,
        guard: Arc<G>,
        scope: OperationScope,
        view: OperationView,
    ) -> std::result::Result<Self, Box<RamClaimJournalFailure<G>>> {
        // Every owner moves before the first fallible phase/lease/native check.
        let owner = Box::new(Owner {
            store,
            handle,
            guard,
            scope,
            view,
            closed: false,
            close_error: None,
        });
        let checked = (|| {
            owner.lease()?;
            let actual: Arc<dyn ScopeGuard> = owner.guard.clone();
            need(
                Arc::ptr_eq(&actual, &owner.store.guard),
                "RAM_JOURNAL_GUARD_CHANGED",
            )?;
            owner.guard.assert_ram_claim_scope(&owner.scope)?;
            owner.validate()
        })();
        match checked {
            Ok(()) => Ok(Self { owner: Some(owner) }),
            Err(cause) => Err(failure(owner, cause)),
        }
    }
    pub fn suspend(
        mut self,
    ) -> std::result::Result<SuspendedRamClaimJournal<G>, Box<RamClaimJournalFailure<G>>> {
        let owner = self.owner.take().expect("whole active RAM journal");
        let checked = owner
            .guard
            .assert_ram_claim_scope(&owner.scope)
            .and_then(|()| owner.validate());
        match checked {
            Ok(()) => Ok(SuspendedRamClaimJournal { owner: Some(owner) }),
            Err(cause) => Err(failure(owner, cause)),
        }
    }
    pub fn begin_effect(
        &mut self,
        effect: Effect,
        version: ProfileVersion,
    ) -> Result<OperationView> {
        let owner = self.owner.as_mut().expect("whole active RAM journal");
        owner.lease()?;
        owner.view = owner
            .store
            .begin_effect(&owner.scope, &owner.handle, effect, version)?;
        Ok(owner.view.clone())
    }
    pub fn record_ack(
        &mut self,
        effect: Effect,
        receipt: JournalDigest,
        version: ProfileVersion,
    ) -> Result<OperationView> {
        let owner = self.owner.as_mut().expect("whole active RAM journal");
        owner.lease()?;
        owner.view =
            owner
                .store
                .record_ack(&owner.scope, &owner.handle, effect, receipt, version)?;
        Ok(owner.view.clone())
    }
    pub fn confirm_preparation(&self) -> Result<OperationDocument> {
        let owner = self.owner.as_ref().expect("whole active RAM journal");
        owner.lease()?;
        owner.store.confirm_preparation(&owner.scope, &owner.view)
    }
    pub fn close_component(&mut self) -> std::result::Result<(), Arc<JournalError>> {
        self.owner
            .as_mut()
            .expect("whole active RAM journal")
            .close_component()
    }
}
impl<G: RamClaimScope> SuspendedRamClaimJournal<G> {
    pub fn resume(
        mut self,
        guard: Arc<G>,
    ) -> std::result::Result<RamClaimJournal<G>, Box<RamClaimJournalFailure<G>>> {
        let mut owner = self.owner.take().expect("whole suspended RAM journal");
        // Only metadata comparison precedes the new guard's native bracket.
        // The revoked predecessor is never invoked as a current guard again.
        let checked = guard
            .assert_ram_claim_successor(&owner.guard, &owner.scope)
            .and_then(|()| guard.assert_ram_claim_scope(&owner.scope));
        if let Err(cause) = checked {
            return Err(failure(owner, cause));
        }
        let OperationStore {
            inner,
            observer,
            draft_observer,
            guard: _,
            #[cfg(test)]
            identity,
        } = owner.store;
        owner.store = OperationStore {
            inner,
            observer,
            draft_observer,
            guard: guard.clone(),
            #[cfg(test)]
            identity,
        };
        owner.guard = guard;
        match owner.validate() {
            Ok(()) => Ok(RamClaimJournal { owner: Some(owner) }),
            Err(cause) => Err(failure(owner, cause)),
        }
    }
    pub fn close_component(&mut self) -> std::result::Result<(), Arc<JournalError>> {
        self.owner
            .as_mut()
            .expect("whole suspended RAM journal")
            .close_component()
    }
}
impl<G: RamClaimScope> RamClaimJournalFailure<G> {
    pub fn cause(&self) -> &Arc<JournalError> {
        &self.cause
    }
    pub fn close_component(&mut self) -> std::result::Result<(), Arc<JournalError>> {
        self.owner
            .as_mut()
            .expect("whole failed RAM journal")
            .close_component()
    }
}
impl<G: RamClaimScope> std::fmt::Debug for RamClaimJournalFailure<G> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RamClaimJournalFailure")
            .field("cause", &self.cause)
            .field(
                "operation",
                &self.owner.as_ref().map(|owner| owner.handle.operation_id()),
            )
            .finish_non_exhaustive()
    }
}
impl<G: RamClaimScope> Drop for RamClaimJournal<G> {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.take() {
            std::mem::forget(owner);
        }
    }
}
impl<G: RamClaimScope> Drop for SuspendedRamClaimJournal<G> {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.take() {
            std::mem::forget(owner);
        }
    }
}
impl<G: RamClaimScope> Drop for RamClaimJournalFailure<G> {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.take() {
            std::mem::forget(owner);
        }
    }
}
