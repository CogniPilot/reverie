//! Weak native observation for an actual resource operation's journal guard.
//! This is not cookie approval, program qualification, admission or a grant.
use super::*;
/// Preserve the existing Q diagnostic API; the shared typed transport cause
/// is not a journal, registration or owner capability.
pub type ResourceJournalError = WorkerActorPinError;
type JournalResult<T> = std::result::Result<T, ResourceJournalError>;

pub struct ResourceJournalPin {
    native: super::current_pin::ActorCurrentPin,
}
impl WorkerActorChannel {
    /// The actual authenticated App owner invokes this only after its fresh
    /// native/current-cookie exchange. No fd/socket/Hold is copied or minted.
    pub fn retain_resource_journal_pin(
        &self,
        expected: &Arc<WorkerReportService>,
    ) -> JournalResult<ResourceJournalPin> {
        self.retain_resource_journal_pin_native(expected)
            .map_err(Into::into)
    }
    fn retain_resource_journal_pin_native(
        &self,
        expected: &Arc<WorkerReportService>,
    ) -> Result<ResourceJournalPin> {
        self.assert_service(expected)?;
        if self.purpose != Purpose::ResourceWebsite
            || !self.greeted
            || self.close != ClosePhase::Open
        {
            return Err(WorkerReportError::Unconfirmed);
        }
        Ok(ResourceJournalPin {
            native: super::current_pin::ActorCurrentPin::capture(
                self,
                super::current_pin::PinPurpose::ResourceJournal,
            )?,
        })
    }
}
impl ResourceJournalPin {
    /// Exact original weak native currentness only. The actual Gate additionally
    /// binds this Q pin to SAME Active/operation, current company and expiry.
    pub fn assert_current(&self) -> JournalResult<()> {
        self.native.current().map_err(Into::into)
    }
}
