//! Shared weak native currentness, not a website, owner or action grant.
//! The original channel alone owns and closes every descriptor and Hold.
use super::*;
use std::sync::Weak;

/// Typed diagnostic custody shared by purpose-specific native transport pins.
/// This carries no authority; the Mutex preserves a possible Send-only native
/// owner inside WorkerReportError without erasing its original close cause.
#[derive(Debug)]
pub struct WorkerActorPinError {
    code: &'static str,
    cause: Mutex<WorkerReportError>,
}
impl From<WorkerReportError> for WorkerActorPinError {
    fn from(cause: WorkerReportError) -> Self {
        Self {
            code: cause.code(),
            cause: Mutex::new(cause),
        }
    }
}
impl WorkerActorPinError {
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
impl std::fmt::Display for WorkerActorPinError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str(self.code)
    }
}
impl std::error::Error for WorkerActorPinError {}

pub(super) struct ActorCurrentPin {
    service: Weak<WorkerReportService>,
    record: Weak<Record>,
    hold: Weak<()>,
    peer: Weak<super::shared_peer::SharedActorPeer>,
}
pub(super) enum PinPurpose {
    ResourceJournal,
    PoolRegistration,
}
impl ActorCurrentPin {
    /// Only the purpose-checked, open and greeted constructors call this.
    /// Capturing Weak identities never copies an fd, socket or logical Hold.
    pub(super) fn capture(channel: &WorkerActorChannel, purpose: PinPurpose) -> Result<Self> {
        let expected = match purpose {
            PinPurpose::ResourceJournal => Purpose::ResourceWebsite,
            PinPurpose::PoolRegistration => Purpose::PoolRegistrationWebsite,
        };
        if channel.purpose != expected || !channel.greeted || channel.close != ClosePhase::Open {
            return Err(WorkerReportError::Unconfirmed);
        }
        channel.require_connected()?;
        let peer = channel
            .peer
            .as_ref()
            .ok_or(WorkerReportError::Unconfirmed)?;
        let pin = Self {
            service: Arc::downgrade(&channel.connection.service),
            record: Arc::downgrade(&channel.connection.record),
            hold: Arc::downgrade(&channel.hold.identity),
            peer: Arc::downgrade(peer),
        };
        pin.current()?;
        Ok(pin)
    }
    pub(super) fn current(&self) -> Result<()> {
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
        if super::super::peer_pin::socket_disconnected(socket)? {
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
