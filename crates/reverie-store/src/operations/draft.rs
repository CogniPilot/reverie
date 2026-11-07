use super::*;
use reverie_contracts::reservation_observation::ReservationObservation;
use reverie_core::decimal::UnsignedInteger;
/// Installed fixed-purpose preview owner. The document is immutable DATA while
/// this store owns its canonical reader/flock; no raw lock token/editor escapes.
/// The application captures its actual held gate/scope and calls retained_delta
/// directly, never reentering this journal store from the observer.
pub trait DraftObserver: Send + Sync {
    fn observe_draft(
        &self,
        scope: &OperationScope,
        document: &OperationDocument,
    ) -> Result<DraftObservation>;
}
pub struct DraftObservation {
    pub observation: ReservationObservation,
    pub retained_bytes: UnsignedInteger,
}
pub struct DraftSnapshot {
    document: OperationDocument,
    observed: DraftObservation,
}
impl DraftSnapshot {
    pub fn document(&self) -> &OperationDocument {
        &self.document
    }
    pub fn observation(&self) -> &ReservationObservation {
        &self.observed.observation
    }
    pub fn retained_bytes(&self) -> &UnsignedInteger {
        &self.observed.retained_bytes
    }
    pub fn into_parts(self) -> (OperationDocument, DraftObservation) {
        (self.document, self.observed)
    }
}
impl OperationStore {
    /// Dedicated preview construction. Current open/claim observer semantics
    /// are unchanged; this path cannot mint a claim handle or native permit.
    pub fn open_draft(
        path: impl AsRef<Path>,
        guard: Arc<dyn ScopeGuard>,
        observer: Arc<dyn DraftObserver>,
    ) -> Result<Self> {
        let mut store = Self::open(path, guard, None)?;
        store.draft_observer = Some(observer);
        Ok(store)
    }
    pub fn observe_draft(&self, scope: &OperationScope) -> Result<DraftSnapshot> {
        self.locked(scope, false, None, |_, current, _, _| {
            let document = current.expect("existing read");
            let observer = self
                .draft_observer
                .as_ref()
                .ok_or(JournalError::refusal("MISSING_DRAFT_OBSERVER"))?;
            let observed = observer.observe_draft(scope, &document)?;
            Ok(DraftSnapshot { document, observed })
        })
    }
}
/// Unapproved opaque references, allocated through the same reviewed CSPRNG
/// owner. They contain no claim, held lock, owner grant or execution permission.
pub struct DraftReferences {
    pub operation: JournalId,
    pub reservation: JournalId,
    pub draft: JournalId,
}
pub fn allocate_draft_references() -> Result<DraftReferences> {
    Ok(DraftReferences {
        operation: allocate_profile_target()?,
        reservation: allocate_profile_target()?,
        draft: allocate_profile_target()?,
    })
}
pub fn allocate_profile_target() -> Result<JournalId> {
    Ok(JournalId::parse(&private_fs::random_uuid()?)?)
}
