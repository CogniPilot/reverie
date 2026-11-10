//! Establish-only provider denial fence. No fleet/effect/release authority.
use super::*;
use reverie_contracts::reservation_control::{PoolTransitionIntent, PoolTransitionSelection};
use reverie_host::reservation_control::PoolTransitionPending;
mod cleanup;
mod publication;
pub(super) use cleanup::OriginalCleanupAdmission;
pub(crate) use publication::{PoolMigrationPublished, PublishedPool};
#[cfg(test)]
mod tests;

enum Pending {
    Attempted,
    Published(PoolTransitionPending),
}
pub(super) struct TransitionRecord {
    config: Arc<ReservationConfiguration>,
    binding: ControlBinding,
    intent: Arc<PoolTransitionIntent>,
    pending: Mutex<Pending>,
    original_cleanup:
        Mutex<Option<reverie_host::worker_reports::WorkerOriginalHandlersCleanupBinding>>,
    published: Mutex<Option<Arc<publication::PublishedConfiguration>>>,
}
/// Minted only after the exclusive durable writer and actual admission close.
/// It grants no maintenance effect, capacity credit or pending-file removal.
#[must_use = "retain the original denial fence; dropping it never clears pending"]
pub struct PoolTransitionFence {
    gate: Arc<Inner>,
    record: Arc<TransitionRecord>,
}
struct RetainedFailure {
    fence: Option<PoolTransitionFence>,
    cause: GateError,
}
#[must_use = "retain the whole attempted transition and original failure"]
pub struct PoolTransitionFailure {
    retained: Option<RetainedFailure>,
}
impl PoolTransitionFailure {
    fn new(fence: Option<PoolTransitionFence>, cause: GateError) -> Box<Self> {
        Box::new(Self {
            retained: Some(RetainedFailure { fence, cause }),
        })
    }
    pub fn cause(&self) -> &GateError {
        &self.retained.as_ref().expect("retained failure").cause
    }
}
impl std::fmt::Debug for PoolTransitionFailure {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        output
            .debug_tuple("PoolTransitionFailure")
            .field(self.cause())
            .finish()
    }
}
impl std::fmt::Display for PoolTransitionFailure {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(self.cause(), output)
    }
}
impl std::error::Error for PoolTransitionFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.cause())
    }
}
impl Drop for PoolTransitionFailure {
    fn drop(&mut self) {
        if let Some(retained) = self.retained.take()
            && retained.fence.is_some()
        {
            std::mem::forget(retained);
        }
    }
}
impl ReservationGate {
    /// Trusted lower denial-only component, not a public transport producer.
    /// A future real fleet authority must own this before any global effect.
    /// No production service selects this method in this bounded cohort.
    pub fn establish_pool_transition(
        &self,
        selected: &PoolTransitionSelection,
        bounds: AdmissionBounds,
    ) -> std::result::Result<PoolTransitionFence, Box<PoolTransitionFailure>> {
        let admission = self
            .inner
            .admit(bounds)
            .map_err(|cause| PoolTransitionFailure::new(None, cause))?;
        let mut fence = None;
        let body = (|| {
            self.inner.require_host_job_idle()?;
            let document = self.inner.document()?;
            need(
                self.inner.active_operations(&document)?.is_empty(),
                "POOL_TRANSITION_RESOURCE_WORK_RETAINED",
            )?;
            need(
                document.operations().is_empty(),
                "POOL_TRANSITION_RESOURCE_HISTORY_RETAINED",
            )?;
            need(
                reservation_control::read_host_job_intent(self.inner.config()?.as_ref())?.is_none(),
                "POOL_TRANSITION_HOST_HISTORY_RETAINED",
            )?;
            self.inner.guard(None)?;
            let config = self.inner.config()?;
            let binding = self
                .inner
                .binding
                .read()
                .map_err(|_| GateError::Refused("RESERVATION_ADMISSION_UNAVAILABLE"))?
                .clone();
            let intent = Arc::new(PoolTransitionIntent::capture(
                selected,
                &self.inner.scope,
                &binding,
                config.configuration(),
            )?);
            let record = Arc::new(TransitionRecord {
                config,
                binding,
                intent,
                pending: Mutex::new(Pending::Attempted),
                original_cleanup: Mutex::new(None),
                published: Mutex::new(None),
            });
            self.inner.retain_pool_transition(&record)?;
            fence = Some(PoolTransitionFence {
                gate: self.inner.clone(),
                record: record.clone(),
            });
            // Acquire the destination before the writer: no fallible lock
            // acquisition may discard an already-published native owner.
            let mut pending = record
                .pending
                .lock()
                .map_err(|_| GateError::Refused("POOL_TRANSITION_REQUIRES_RECONCILIATION"))?;
            let published = {
                let active = self.inner.held(None)?;
                let admission = active
                    .lock
                    .lock()
                    .map_err(|_| GateError::Refused("RESERVATION_ADMISSION_UNAVAILABLE"))?;
                PoolTransitionPending::establish(
                    &record.config,
                    &record.binding,
                    &admission,
                    record.intent.clone(),
                )?
            };
            *pending = Pending::Published(published);
            let Pending::Published(published) = &*pending else {
                unreachable!("assigned native owner");
            };
            published.assert_current(&record.config)?;
            drop(pending);
            record
                .intent
                .assert_configuration(self.inner.config()?.configuration())?;
            Ok(())
        })();
        // Pending is deliberately unknown to every legacy/native admission.
        // Do not use finish(): its success guard must refuse the new fence.
        match finalized(body, admission.abort()) {
            Ok(()) => Ok(fence.expect("published fence")),
            Err(cause) => Err(PoolTransitionFailure::new(fence, cause)),
        }
    }
}
impl Inner {
    fn retain_pool_transition(&self, record: &Arc<TransitionRecord>) -> Result<()> {
        let mut slot = self
            .pool_transition
            .lock()
            .map_err(|_| GateError::Refused("POOL_TRANSITION_REQUIRES_RECONCILIATION"))?;
        need(slot.is_none(), "POOL_TRANSITION_REQUIRES_RECONCILIATION")?;
        *slot = Some(record.clone());
        Ok(())
    }
    pub(super) fn assert_no_pool_transition(&self) -> Result<()> {
        need(
            self.pool_transition
                .lock()
                .map_err(|_| GateError::Refused("POOL_TRANSITION_REQUIRES_RECONCILIATION"))?
                .is_none(),
            "POOL_TRANSITION_REQUIRES_RECONCILIATION",
        )
    }
}
impl PoolTransitionFence {
    pub fn operation_id(&self) -> &JournalId {
        self.record.intent.operation_id()
    }
    /// Consuming read-side check. Any failure retains the original whole owner;
    /// there is no retry/extraction/clear operation on the failure.
    pub fn assert_current(self) -> std::result::Result<Self, Box<PoolTransitionFailure>> {
        match self.current() {
            Ok(()) => Ok(self),
            Err(cause) => Err(PoolTransitionFailure::new(Some(self), cause)),
        }
    }
    fn current(&self) -> Result<()> {
        need(
            self.gate
                .pool_transition
                .lock()
                .map_err(|_| GateError::Refused("POOL_TRANSITION_REQUIRES_RECONCILIATION"))?
                .as_ref()
                .is_some_and(|record| Arc::ptr_eq(record, &self.record)),
            "POOL_TRANSITION_REQUIRES_RECONCILIATION",
        )?;
        self.record
            .intent
            .assert_configuration(self.gate.config()?.configuration())?;
        let mut admission = AdmissionLock::acquire(&self.record.config)?;
        let body = (|| {
            need(
                self.record
                    .binding
                    .matches_metadata(&reservation_control::read_marker(&self.record.config)?),
                "RESERVATION_BINDING_CHANGED",
            )?;
            reservation_control::guard_layout(
                &self.record.config,
                &self.record.binding,
                &admission,
            )?;
            self.record.assert_pending()
        })();
        finalized(body, admission.close().map_err(Into::into))
    }
}
impl TransitionRecord {
    fn assert_pending(&self) -> Result<()> {
        let pending = self
            .pending
            .lock()
            .map_err(|_| GateError::Refused("POOL_TRANSITION_REQUIRES_RECONCILIATION"))?;
        let Pending::Published(pending) = &*pending else {
            return Err(GateError::Refused(
                "POOL_TRANSITION_REQUIRES_RECONCILIATION",
            ));
        };
        pending.assert_current(&self.config).map_err(Into::into)
    }
}
