use super::*;
pub(super) enum TargetAttempt {
    Offer(Option<installation_offer::SharedInstallationOffer>),
    View(OfferPreparationView),
    Observed(Box<ObservedOfferTarget>),
    Failed(Box<OfferTargetObservationFailure>),
    Moving,
}
pub(super) struct TargetClosed<'a> {
    _owner: &'a mut TargetAttempt,
}
impl TargetAttempt {
    pub(super) fn capture_view(
        &mut self,
        broker: &Arc<InstallingBroker>,
    ) -> Result<Instant, Cause> {
        if let Self::View(view) = self {
            view.assert_preview_broker(broker)
                .map_err(|e| Cause::Offer(Box::new(e)))?;
            return Ok(view.original_deadline());
        }
        let Self::Offer(Some(offer)) = self else {
            return Err(Cause::Refused("FLEET_PREVIEW_SETUP_REQUIRED"));
        };
        let view = offer
            .preparation_view(broker)
            .map_err(|e| Cause::Offer(Box::new(e)))?;
        let end = view.original_deadline();
        *self = Self::View(view);
        Ok(end)
    }
    pub(super) fn observe(&mut self) -> Result<(), Cause> {
        let view = match std::mem::replace(self, Self::Moving) {
            Self::View(view) => view,
            original => {
                *self = original;
                return Err(Cause::Refused("FLEET_PREVIEW_TARGET_STATE"));
            }
        };
        match view.observe_target() {
            Ok(target) => {
                *self = Self::Observed(Box::new(target));
                Ok(())
            }
            Err(failure) => {
                let cause = failure.retained_cause();
                *self = Self::Failed(failure);
                Err(Cause::Target(cause))
            }
        }
    }
    pub(super) fn current(&mut self) -> Result<UnpreparedOfferBinding, Cause> {
        match self {
            Self::Observed(target) => target.read_current().map_err(Cause::Target),
            _ => Err(Cause::Refused("FLEET_PREVIEW_TARGET_STATE")),
        }
    }
    pub(super) fn qualify_images(
        &mut self,
        inputs: &PoolImageInputsData,
    ) -> Result<[String; 2], Cause> {
        match self {
            Self::Observed(target) => target
                .qualify_observed_images(inputs)
                .map_err(Cause::Target),
            _ => Err(Cause::Refused("FLEET_PREVIEW_TARGET_STATE")),
        }
    }
    pub(super) fn binding(
        &self,
        frame: &Frame<'_>,
        principal: &ResourceOwnerPrincipal,
    ) -> Result<(), Cause> {
        let Self::Observed(target) = self else {
            return Err(Cause::Refused("FLEET_PREVIEW_TARGET_STATE"));
        };
        let snapshot = frame
            .snapshot
            .as_ref()
            .ok_or(Cause::Refused("FLEET_PREVIEW_SNAPSHOT_REQUIRED"))?;
        target
            .assert_fleet_preview_binding(frame.broker, snapshot, principal)
            .map_err(Cause::Target)
    }
    pub(super) fn close(&mut self) -> Result<TargetClosed<'_>, Cause> {
        match self {
            Self::Offer(_) | Self::View(_) => {}
            Self::Observed(target) => {
                let _closed = target.close_queries().map_err(Cause::Target)?;
            }
            Self::Failed(target) => {
                let _closed = target.close_queries().map_err(Cause::Target)?;
            }
            Self::Moving => return Err(Cause::Refused("FLEET_PREVIEW_TARGET_STATE")),
        }
        Ok(TargetClosed { _owner: self })
    }
}
