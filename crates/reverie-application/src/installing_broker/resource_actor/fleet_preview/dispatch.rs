//! Real retained-Q migration consumer. Prefix refusals close only their own
//! query/channel components; a started migration failure remains whole-owned.
use super::*;

pub(in crate::installing_broker) enum FleetDispatchClosed {
    Preview(FleetPreviewClosed),
    Migration(PoolMigrationClosed),
}
pub(in crate::installing_broker) enum FleetDispatchFailure<'a> {
    Preview(Box<FleetPreviewFailure<'a>>),
    Migration(Box<PoolMigrationFailure<'a>>),
}
impl FleetDispatchClosed {
    pub(in crate::installing_broker) fn primary_error_code(&self) -> Option<&'static str> {
        match self {
            Self::Preview(closed) => closed.primary_error_code(),
            Self::Migration(closed) => closed.primary_error_code(),
        }
    }
}
impl std::fmt::Display for FleetDispatchClosed {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Preview(closed) => closed.fmt(out),
            Self::Migration(closed) => closed.fmt(out),
        }
    }
}
impl std::fmt::Display for FleetDispatchFailure<'_> {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Preview(owner) => owner.fmt(out),
            Self::Migration(owner) => owner.fmt(out),
        }
    }
}
impl FleetDispatchFailure<'_> {
    pub(in crate::installing_broker) fn settle_for_worker(
        self: Box<Self>,
    ) -> std::result::Result<FleetDispatchClosed, Box<Self>> {
        match *self {
            Self::Preview(owner) => owner
                .settle_for_worker()
                .map(FleetDispatchClosed::Preview)
                .map_err(|owner| Box::new(Self::Preview(owner))),
            retained @ Self::Migration(_) => Err(Box::new(retained)),
        }
    }
}
impl InstallingBroker {
    pub(in crate::installing_broker) fn handle_fleet_operation<'a>(
        self: &'a Arc<Self>,
        connection: WorkerServiceConnection,
        offer: Option<installation_offer::SharedInstallationOffer>,
    ) -> std::result::Result<FleetDispatchClosed, Box<FleetDispatchFailure<'a>>> {
        if offer.is_none() {
            return self
                .handle_fleet_preview(connection, None)
                .map(FleetDispatchClosed::Preview)
                .map_err(|owner| Box::new(FleetDispatchFailure::Preview(owner)));
        }
        let mut owner = NativeFleetPreview::incoming(self, connection, TargetAttempt::Offer(offer));
        if let Err(cause) = owner
            .prepare(self)
            .and_then(|()| owner.qualify_fixed_inputs())
        {
            return Box::new(FleetDispatchFailure::Preview(owner.into_failure(cause)))
                .settle_for_worker();
        }
        let authorization = match (QualifiedFleetPreview { owner })
            .authenticate_maintenance()
            .and_then(AuthenticatedFleetMaintenance::into_pool_migration)
        {
            Ok(authorization) => authorization,
            Err(owner) => {
                return Box::new(FleetDispatchFailure::Preview(owner)).settle_for_worker();
            }
        };
        authorization
            .execute(self)
            .map(FleetDispatchClosed::Migration)
            .map_err(|owner| Box::new(FleetDispatchFailure::Migration(owner)))
    }
}
