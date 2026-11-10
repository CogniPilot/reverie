use super::*;
pub(super) enum TargetAttempt {
    Offer(Option<installation_offer::SharedInstallationOffer>),
    View(OfferPreparationView),
    Observed(Box<ObservedOfferTarget>),
    Failed(Box<OfferTargetObservationFailure>),
    Transferred {
        target: Box<ObservedOfferTarget>,
        binding: UnpreparedOfferBinding,
    },
    Moving,
}
pub(super) struct TargetClosed<'a> {
    _owner: &'a mut TargetAttempt,
}
impl TargetAttempt {
    pub(super) fn assert_migration_transferred(&self) -> Result<()> {
        let Self::Transferred { target, .. } = self else {
            return Err(Cause::Refused("POOL_MIGRATION_SOURCE_NOT_TRANSFERRED"));
        };
        target.assert_migration_transferred().map_err(Cause::Target)
    }
    pub(super) fn migration_identity(&self) -> Result<installation_offer::MigrationOfferIdentity> {
        match self {
            Self::Observed(target) => Ok(target.migration_identity()),
            _ => Err(Cause::Refused("POOL_MIGRATION_TARGET_STATE")),
        }
    }
    pub(super) fn transfer_migration_source(
        &mut self,
        authorization: &PoolMigrationSourceAuthorization<'_>,
        binding: UnpreparedOfferBinding,
    ) -> Result<(BrokerControllerBootstrap, u32)> {
        let Self::Observed(target) = self else {
            return Err(Cause::Refused("POOL_MIGRATION_TARGET_STATE"));
        };
        let source = target
            .take_migration_source(authorization)
            .map_err(Cause::Target)?;
        let Self::Observed(target) = std::mem::replace(self, Self::Moving) else {
            unreachable!("same target retained across transfer");
        };
        *self = Self::Transferred { target, binding };
        Ok(source)
    }
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
            Self::Transferred { target, binding } => {
                target
                    .assert_migration_transferred()
                    .map_err(Cause::Target)?;
                Ok(binding.clone())
            }
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
        if let Self::Transferred { target, .. } = self {
            return target.assert_migration_transferred().map_err(Cause::Target);
        }
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
            Self::Transferred { target, .. } => {
                let _closed = target.close_queries().map_err(Cause::Target)?;
            }
            Self::Moving => return Err(Cause::Refused("FLEET_PREVIEW_TARGET_STATE")),
        }
        Ok(TargetClosed { _owner: self })
    }
}
