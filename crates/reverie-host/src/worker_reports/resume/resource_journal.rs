//! Weak native observation for an actual resource operation's journal guard.
//! Native read-only cancellation observation. This is not cookie approval,
//! installed-program qualification, Gate admission or a resource capability.
use super::*;
use std::sync::Weak;

/// Retains the complete original error, including any native owner it carries.
/// WorkerReportError can contain a Send-only telemetry store; the mutex keeps
/// that owner intact when this diagnostic is retained by a shared Gate record.
#[derive(Debug)]
pub struct ResourceJournalError {
    code: &'static str,
    cause: Mutex<WorkerReportError>,
}
impl From<WorkerReportError> for ResourceJournalError {
    fn from(cause: WorkerReportError) -> Self {
        Self {
            code: cause.code(),
            cause: Mutex::new(cause),
        }
    }
}
impl ResourceJournalError {
    pub fn code(&self) -> &'static str {
        self.code
    }
    pub fn has_unconfirmed_close(&self) -> bool {
        let cause = self
            .cause
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        cause.has_unconfirmed_close()
    }
}
impl std::fmt::Display for ResourceJournalError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str(self.code)
    }
}
impl std::error::Error for ResourceJournalError {}
type JournalResult<T> = std::result::Result<T, ResourceJournalError>;

pub struct ResourceJournalPin {
    service: Weak<WorkerReportService>,
    record: Weak<Record>,
    hold: Weak<()>,
    peer: Weak<super::shared_peer::SharedActorPeer>,
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
        self.require_connected()?;
        let peer = self.peer.as_ref().ok_or(WorkerReportError::Unconfirmed)?;
        let pin = ResourceJournalPin {
            service: Arc::downgrade(&self.connection.service),
            record: Arc::downgrade(&self.connection.record),
            hold: Arc::downgrade(&self.hold.identity),
            peer: Arc::downgrade(peer),
        };
        pin.current()?;
        Ok(pin)
    }
}
impl ResourceJournalPin {
    /// Try-locks only, zero-time pidfd polls and nonblocking EOF observation on
    /// the exact original socket. The actual Gate additionally binds this pin
    /// to its SAME Active/operation, current company owner and fixed expiry.
    pub fn assert_current(&self) -> JournalResult<()> {
        self.current().map_err(Into::into)
    }
    fn current(&self) -> Result<()> {
        let service = self
            .service
            .upgrade()
            .ok_or(WorkerReportError::Unconfirmed)?;
        let record = self
            .record
            .upgrade()
            .ok_or(WorkerReportError::Unconfirmed)?;
        let hold = self.hold.upgrade().ok_or(WorkerReportError::Unconfirmed)?;
        let peer = self.peer.upgrade().ok_or(WorkerReportError::Unconfirmed)?;
        assert_member(&service, &record)?;
        record.assert_lifecycle_hold(&hold)?;
        peer.require_alive()?;
        let stream = record.terminal_stream()?;
        let socket = stream.as_ref().ok_or(WorkerReportError::Unconfirmed)?;
        if super::super::peer_pin::socket_ended(socket)? {
            return Err(WorkerReportError::Peer);
        }
        drop(stream);
        peer.require_alive()?;
        record.assert_lifecycle_hold(&hold)?;
        assert_member(&service, &record)
    }
}
fn assert_member(service: &Arc<WorkerReportService>, record: &Arc<Record>) -> Result<()> {
    if service.stopping() {
        return Err(WorkerReportError::Stopping);
    }
    if service.opaque.load(Ordering::Acquire) {
        return Err(WorkerReportError::Unconfirmed);
    }
    let records = service.records.try_lock().map_err(|error| {
        if matches!(error, TryLockError::Poisoned(_)) {
            service.opaque.store(true, Ordering::Release);
        }
        WorkerReportError::Unconfirmed
    })?;
    if !records.iter().any(|original| Arc::ptr_eq(original, record)) {
        return Err(WorkerReportError::Unconfirmed);
    }
    Ok(())
}
