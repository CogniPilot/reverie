//! A genuine accepted worker connection may retain its existing admission through the actual
//! application lifecycle. There is no second cap, fd duplication or wire key.
use super::*;

pub(super) enum LifecycleHoldState {
    Unissued,
    Held(Arc<()>),
    Released(Arc<()>),
}
/// Physical close and application lifecycle completion are different facts.
/// Neither variant is a native process/storage/global release acknowledgement.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkerLaunchClose {
    Complete,
    SocketClosedLifecycleHeld,
    SocketClosedHandlerRetained,
}
/// Only a genuine accepted worker connection can issue this one-shot resource.
/// Default Drop leaves the strong Held identity in the SAME counted record;
/// the caller must retain it with unknown actual resources, not reconstruct it
/// later from a SID, request or descriptor number.
#[must_use = "retain through actual lifecycle finalization or known ownership transfer"]
pub struct WorkerLaunchHold {
    pub(super) service: Arc<WorkerReportService>,
    pub(super) record: Arc<Record>,
    pub(super) identity: Arc<()>,
}
impl WorkerLaunchHold {
    /// Close only this logical lifecycle hold, after the actual application's
    /// known finalization/transfer. A live socket still counts afterward. An
    /// opaque descriptor close can never be forgiven by releasing this hold.
    ///
    /// Lock order is records -> hold. No stream/control lock is acquired here;
    /// both acquisitions use the caller's original bound clipped by first stop.
    pub fn release(&mut self, requested: Instant) -> Result<()> {
        self.release_budget(&super::budget::CleanupBudget::bounded(
            &self.service,
            requested,
        ))
    }
    pub fn release_for_worker(&mut self) -> Result<()> {
        self.release_budget(&super::budget::CleanupBudget::worker(&self.service))
    }
    fn release_budget(&self, budget: &super::budget::CleanupBudget<'_>) -> Result<()> {
        let mut records = self.service.lock_budget(budget)?;
        let mut state = self.record.lifecycle_until(budget)?;
        if self.service.opaque.load(Ordering::Acquire) || self.record.opaque() {
            return Err(WorkerReportError::Unconfirmed);
        }
        match &*state {
            LifecycleHoldState::Held(identity) if Arc::ptr_eq(identity, &self.identity) => {
                if !records.iter().any(|entry| Arc::ptr_eq(entry, &self.record)) {
                    self.service.opaque.store(true, Ordering::Release);
                    return Err(WorkerReportError::Unconfirmed);
                }
                *state = LifecycleHoldState::Released(self.identity.clone());
            }
            LifecycleHoldState::Released(identity) if Arc::ptr_eq(identity, &self.identity) => {}
            _ => return Err(WorkerReportError::Unconfirmed),
        }
        drop(state);
        if self.record.socket_closed_known() && self.record.handler_settled() {
            records.retain(|entry| !Arc::ptr_eq(entry, &self.record));
        }
        Ok(())
    }
}
