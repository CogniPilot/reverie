//! Fixed installed-source preparation entry. The original acquired lease is
//! fenced BEFORE reservation mutation and stays held through baseline/finalizer
//! and source join. No callback, new lease or effect permission is accepted.
pub(crate) use super::storage::RegisteredSource;
use super::*;
use crate::reservation_gate::{DraftRetentionFailure, EnteredResourceDraft, RetainedPreparation};
use reverie_core::operations::{JournalDigest, JournalId};
#[cfg(test)]
mod tests;

#[derive(Debug)]
pub enum SourceDraftError {
    Gate(Box<GateError>),
    Storage(Box<StorageWorkflowError>),
    Refused(&'static str),
    Finalization {
        primary: Box<Self>,
        secondary: Box<Self>,
    },
}
impl SourceDraftError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Gate(error) => error.code(),
            Self::Storage(error) => error.code(),
            Self::Refused(code) => code,
            Self::Finalization { .. } => "RESOURCE_SOURCE_ATTACH_FINALIZATION",
        }
    }
}
impl std::fmt::Display for SourceDraftError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for SourceDraftError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Gate(error) => Some(error.as_ref()),
            Self::Storage(error) => Some(error.as_ref()),
            Self::Refused(_) => None,
            Self::Finalization { primary, .. } => Some(primary.as_ref()),
        }
    }
}
impl From<GateError> for SourceDraftError {
    fn from(error: GateError) -> Self {
        Self::Gate(Box::new(error))
    }
}
impl From<StorageWorkflowError> for SourceDraftError {
    fn from(error: StorageWorkflowError) -> Self {
        Self::Storage(Box::new(error))
    }
}
fn finalized(primary: SourceDraftError, secondary: SourceDraftError) -> SourceDraftError {
    SourceDraftError::Finalization {
        primary: Box::new(primary),
        secondary: Box::new(secondary),
    }
}
fn abort(entry: EnteredResourceDraft<'_>, primary: SourceDraftError) -> SourceDraftError {
    match entry.abort() {
        Ok(()) => primary,
        Err(error) => finalized(primary, error.into()),
    }
}
fn original<'a>(
    lifecycle: &'a LaptopLifecycle<'_>,
    session: &ProfileSessionId,
) -> Result<&'a recovered::RecoveredLaptop, SourceDraftError> {
    let selected = lifecycle
        .guard
        .iter()
        .find(|entry| &entry.session == session)
        .ok_or(SourceDraftError::Refused(
            "RESOURCE_ORIGINAL_SOURCE_OWNER_REQUIRED",
        ))?;
    match &selected.owner {
        LaptopOwner::Recovered(owner) => Ok(owner),
        // Staging refusal: the completed Started source borrower must retain
        // its actual Host record; it must never fabricate a Recovered/Direct.
        LaptopOwner::Started(_) => Err(SourceDraftError::Refused(
            "RESOURCE_STARTED_SOURCE_BORROW_REQUIRED",
        )),
        #[cfg(test)]
        LaptopOwner::Modeled => Err(SourceDraftError::Refused(
            "RESOURCE_ORIGINAL_SOURCE_OWNER_REQUIRED",
        )),
    }
}
fn join(
    attached: storage::SourceAttachment<'_>,
    result: Result<RetainedPreparation, DraftRetentionFailure>,
) -> Result<RetainedPreparation, SourceDraftError> {
    match result {
        Ok(claim) => join_claim(attached, claim),
        Err(failure) => {
            let primary = SourceDraftError::from(failure.cause);
            if failure.may_have_claimed {
                return Err(primary);
            }
            Err(match attached.restore_unclaimed() {
                Ok(()) => primary,
                Err(error) => finalized(primary, error.into()),
            })
        }
    }
}
fn join_claim(
    attached: storage::SourceAttachment<'_>,
    claim: RetainedPreparation,
) -> Result<RetainedPreparation, SourceDraftError> {
    match attached.join(claim) {
        Ok(claim) => Ok(claim),
        Err(failure) => {
            let (claim, error) = *failure;
            let primary = SourceDraftError::from(error);
            Err(match claim.close() {
                Ok(()) => primary,
                Err(error) => finalized(primary, error.into()),
            })
        }
    }
}
impl InstallingBroker {
    /// Enumerate the actual retained Source records and attempt all their native
    /// settlements. This closes no source resource and is no global shutdown ACK.
    pub fn settle_original_sources(&self, end: std::time::Instant) -> Result<(), GateError> {
        self.storage.settle_original_sources(end)
    }
    /// Trusted installing composition, not owner/API authorization. The
    /// standalone Gate draft reader intentionally retains no source resource.
    pub fn retain_resource_draft(
        &self,
        id: &JournalId,
        digest: &JournalDigest,
    ) -> Result<RetainedPreparation, SourceDraftError> {
        let gate = self
            .resource_reservations()?
            .ok_or(SourceDraftError::Refused(
                "RESOURCE_PREPARATION_GATE_REQUIRED",
            ))?;
        let entered = gate.enter_resource_draft(id, digest)?;
        if !entered.installed_is(&self.installed) {
            return Err(abort(
                entered,
                SourceDraftError::Refused("RESOURCE_PREPARATION_BROKER_CHANGED"),
            ));
        }
        let lifecycle = match self.installed.lifecycle() {
            Ok(value) => value,
            Err(error) => return Err(abort(entered, error.into())),
        };
        let original = match original(&lifecycle, entered.profile().binding().current_session()) {
            Ok(value) => value,
            Err(error) => return Err(abort(entered, error)),
        };
        if original.storage.paths().identity() != entered.profile().binding().employee().as_str() {
            return Err(abort(
                entered,
                SourceDraftError::Refused("RESOURCE_ORIGINAL_SOURCE_CHANGED"),
            ));
        }
        let reference = match original.storage.original_source_reference() {
            Ok(value) => value,
            Err(error) => return Err(abort(entered, error.into())),
        };
        let config = match self.configuration() {
            Ok(value) => value,
            Err(error) => return Err(abort(entered, error.into())),
        };
        let attached = match reference.attach(
            config.configuration(),
            entered.operation(),
            original.office.clone(),
        ) {
            Ok(value) => value,
            Err(error) => return Err(abort(entered, error.into())),
        };
        // Both actual lifecycle/registry locks remain held throughout the
        // durable claim, native baseline, admission finish and final join.
        join(attached, entered.retain())
    }
}
