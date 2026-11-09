//! Joined readonly observation of the original offer and its original engine.
//! This does not qualify repository artifacts or authorize any fleet effect.
use super::*;
use reverie_host::worker_pool::PoolTargetObservation;
use std::rc::Rc;
mod error;
pub use error::OfferTargetObservationError;
type Result<T> = std::result::Result<T, Rc<OfferTargetObservationError>>;

#[must_use = "retain both original offer and target query owners through checked close"]
pub struct ObservedOfferTarget {
    view: Option<OfferPreparationView>,
    target: Option<PoolTargetObservation>,
    primary: Option<Rc<OfferTargetObservationError>>,
    cleanup: Option<Rc<OfferTargetObservationError>>,
    closed: bool,
}

#[must_use = "failure retains the same offer, query owner and distinct cleanup cause"]
pub struct OfferTargetObservationFailure {
    owner: ObservedOfferTarget,
    cause: Rc<OfferTargetObservationError>,
}
pub(in crate::installing_broker) struct OfferTargetQueriesClosed<'a> {
    _owner: &'a mut ObservedOfferTarget,
}

impl OfferPreparationView {
    /// Consume the actual view before its first fallible read. Policy DATA is
    /// obtained only from that view; runtime and deadline have no caller input.
    /// No artifact-source, prepared-target, consent or drain grant is returned.
    pub fn observe_target(
        self,
    ) -> std::result::Result<ObservedOfferTarget, Box<OfferTargetObservationFailure>> {
        let mut owner = ObservedOfferTarget {
            view: Some(self),
            target: None,
            primary: None,
            cleanup: None,
            closed: false,
        };
        match owner.read_current() {
            Ok(_) => Ok(owner),
            Err(cause) => Err(Box::new(OfferTargetObservationFailure { owner, cause })),
        }
    }
}

impl ObservedOfferTarget {
    pub(in crate::installing_broker) fn assert_fleet_preview_binding(
        &self,
        broker: &InstallingBroker,
        snapshot: &Arc<ValidatedWorkerSnapshot>,
        principal: &reverie_contracts::resource_actor::ResourceOwnerPrincipal,
    ) -> Result<()> {
        if let Some(cause) = &self.primary {
            return Err(Rc::clone(cause));
        }
        self.view
            .as_ref()
            .expect("original view retained")
            .assert_fleet_preview_binding(broker, snapshot, principal)
            .map_err(|cause| Rc::new(OfferTargetObservationError::offer(cause)))
    }
    pub(in crate::installing_broker) fn close_queries(
        &mut self,
    ) -> Result<OfferTargetQueriesClosed<'_>> {
        self.close_components()?;
        Ok(OfferTargetQueriesClosed { _owner: self })
    }
    /// Each read brackets the SAME original Host observation with fresh reads
    /// of the SAME offer tuple. Returned values remain unprepared DATA only.
    pub fn read_current(&mut self) -> Result<UnpreparedOfferBinding> {
        if let Some(cause) = &self.primary {
            return Err(Rc::clone(cause));
        }
        let result = if self.closed {
            Err(OfferTargetObservationError::Refused(
                "POOL_OFFER_TARGET_CLOSED",
            ))
        } else {
            self.observe()
        };
        result.map_err(|cause| Rc::clone(self.primary.get_or_insert_with(|| Rc::new(cause))))
    }

    fn observe(
        &mut self,
    ) -> std::result::Result<UnpreparedOfferBinding, OfferTargetObservationError> {
        let view = self.view.as_mut().expect("original consumed view retained");
        let binding = view
            .read_current()
            .map_err(OfferTargetObservationError::offer)?;
        let runtime = &view.broker.storage.runtime;
        if self.target.is_none() {
            self.target = Some(
                PoolTargetObservation::capture(runtime, binding.policy(), view.deadline)
                    .map_err(OfferTargetObservationError::Target)?,
            );
        }
        self.target
            .as_mut()
            .expect("original target stored before read")
            .assert_current(runtime, binding.policy())
            .map_err(OfferTargetObservationError::Target)?;
        view.read_current()
            .map_err(OfferTargetObservationError::offer)
    }

    fn close_components(&mut self) -> Result<()> {
        if self.closed {
            return Ok(());
        }
        if let Some(target) = &mut self.target {
            let view = self
                .view
                .as_ref()
                .expect("same view retained through target close");
            if let Err(cause) = target.close(&view.broker.storage.runtime) {
                self.cleanup
                    .get_or_insert_with(|| Rc::new(OfferTargetObservationError::Target(cause)));
            }
        }
        if let Some(cause) = &self.cleanup {
            return Err(Rc::clone(cause));
        }
        self.closed = true;
        Ok(())
    }

    /// Close only this target query scope and release its local view reference.
    /// This never closes shared B origin metadata or certifies fleet readiness.
    /// An earlier read failure remains a failure after known query closure.
    pub fn close(mut self) -> std::result::Result<(), Box<OfferTargetObservationFailure>> {
        let closed = self.close_components();
        match self.primary.clone().or_else(|| closed.err()) {
            Some(cause) => Err(Box::new(OfferTargetObservationFailure {
                owner: self,
                cause,
            })),
            None => Ok(()),
        }
    }
}

impl OfferTargetObservationFailure {
    pub(in crate::installing_broker) fn retained_cause(&self) -> Rc<OfferTargetObservationError> {
        Rc::clone(&self.cause)
    }
    pub(in crate::installing_broker) fn close_queries(
        &mut self,
    ) -> Result<OfferTargetQueriesClosed<'_>> {
        self.owner.close_queries()
    }
    pub fn cause(&self) -> &OfferTargetObservationError {
        &self.cause
    }
    pub fn cleanup_error(&self) -> Option<&OfferTargetObservationError> {
        self.owner.cleanup.as_deref()
    }
    /// Settle the same Host query only, including after origin expiry. Primary
    /// failure stays retained; this is not shared B/native-origin closure.
    pub fn close_components(&mut self) -> Result<()> {
        self.owner.close_components()
    }
}

impl Drop for ObservedOfferTarget {
    fn drop(&mut self) {
        if !self.closed {
            std::mem::forget(self.view.take());
            std::mem::forget(self.target.take());
            std::mem::forget(self.primary.take());
            std::mem::forget(self.cleanup.take());
        }
    }
}
