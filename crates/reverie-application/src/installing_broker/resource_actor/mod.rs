//! Native protected website channel for the actual installing broker. Its
//! constructor has no wire-selected engine/program, callbacks or owner flag.
//! Qualifying a website does not authorize an employee resource operation.
mod close;
mod custody;
mod dispatch;
pub use dispatch::{ResourceOperationClosed, ResourceOperationFailure};
mod error;
mod fleet_preview;
pub(in crate::installing_broker) use error::gate_close_unknown;
pub use fleet_preview::{
    AuthenticatedFleetMaintenance, AuthenticatedPoolMigration, DrainedLegacyFleet,
    DrainedPoolMigration, FleetMaintenanceCheckError, FleetPreviewClosed, FleetPreviewFailure,
    LegacyFleetDrainError, LegacyFleetDrainFailure, PoolMigrationClosed, PoolMigrationFailure,
    QualifiedFleetPreview,
};
#[cfg(test)]
mod native_fixture;
mod operation;
mod pool_registration;
pub(in crate::installing_broker) use pool_registration::{
    PoolRegistrationComponentClosed, PoolRegistrationFailure,
};
mod qualification;
#[cfg(test)]
mod tests;
mod wire;
use super::*;
use crate::reservation_observer::ObservationContext;
pub use error::{ResourceActorError, ResourceActorFailure};
use error::{Result, need};
pub(in crate::installing_broker) use fleet_preview::FleetDispatchFailure;
pub(in crate::installing_broker) use fleet_preview::PoolMigrationSourceAuthorization;
pub use operation::{
    AuthenticatedResourceOperation, ClaimedRamOperation, CommittedRamFailure,
    CommittedRamOperation, PreparedResourceStart, RamClaimFailure, RamPreparationFailure,
    ResourceStartFailure,
};
use reverie_contracts::{human_protocol::HumanFrame, resource_actor::*};
use reverie_host::{
    resource_facts::InstalledFactsObserver,
    website_facts::{
        ImmutableAliasObserver, ImmutableCodeObserver, ImmutableInputObserver, ProcessSnapshot,
        WebsiteMetadataObserver, WebsiteProcessObserver,
    },
    worker_reports::{
        WorkerActorChannel, WorkerActorChannelFailure, WorkerLaunchClose, WorkerServiceConnection,
    },
};
use std::time::{Duration, Instant};

enum Transport {
    Incoming(WorkerServiceConnection),
    Retained(WorkerActorChannel),
    Failed(Box<WorkerActorChannelFailure>),
    Closed,
}
struct Bindings {
    installed: InstalledFactsDocument,
    graph: WebsiteProgramGraph,
    init: ProcessSnapshot,
    peer: ProcessSnapshot,
}
#[derive(Clone, Copy)]
enum WebsitePurpose {
    RamOperation,
    PoolRegistration,
    FleetPreview,
}
struct Frame<'a> {
    purpose: WebsitePurpose,
    broker: &'a InstallingBroker,
    snapshot: Option<Arc<ValidatedWorkerSnapshot>>,
    transport: Transport,
    private: InstalledFactsObserver,
    input: ImmutableInputObserver,
    code: ImmutableCodeObserver,
    aliases: ImmutableAliasObserver,
    processes: WebsiteProcessObserver,
    engine: Option<WebsiteMetadataObserver>,
    context: Option<ObservationContext>,
    bindings: Option<Bindings>,
    deadline: Instant,
    failed: bool,
    frames: usize,
    unconfirmed: Option<custody::RetainedClose>,
    employee_close: Option<Box<reverie_host::worker_pool::PoolError>>,
}
#[must_use = "retain this exact protected channel through actual operation and checked close"]
pub struct InstalledResourceWebsite<'a> {
    frame: Frame<'a>,
}
/// Native website attestation only. This distinct owner exposes no RAM
/// operation, journal authority, owner approval or global administration grant.
#[must_use = "retain the exact installation channel through checked close"]
pub struct InstalledPoolRegistrationWebsite<'a> {
    frame: Frame<'a>,
}
impl InstallingBroker {
    /// Actual accepted Q connection only. The early same counted hold and
    /// kernel peer precede all immutable/private/native qualification.
    pub fn prepare_resource_website(
        &self,
        connection: WorkerServiceConnection,
    ) -> std::result::Result<InstalledResourceWebsite<'_>, Box<ResourceActorFailure<'_>>> {
        self.prepare_website_frame(connection, WebsitePurpose::RamOperation)
            .map(|frame| InstalledResourceWebsite { frame })
    }
    /// Separate actual accepted B connection. This reuses installed native
    /// website proof, never an employee Gate or per-employee approval as a
    /// global registration capability. The original offer/consent must join
    /// this actual owner in a later installation workflow.
    pub fn prepare_pool_registration_website(
        &self,
        connection: WorkerServiceConnection,
    ) -> std::result::Result<InstalledPoolRegistrationWebsite<'_>, Box<ResourceActorFailure<'_>>>
    {
        self.prepare_website_frame(connection, WebsitePurpose::PoolRegistration)
            .map(|frame| InstalledPoolRegistrationWebsite { frame })
    }
    fn prepare_website_frame(
        &self,
        connection: WorkerServiceConnection,
        purpose: WebsitePurpose,
    ) -> std::result::Result<Frame<'_>, Box<ResourceActorFailure<'_>>> {
        self.prepare_website_frame_until(
            connection,
            purpose,
            Instant::now() + Duration::from_secs(300),
        )
    }
    fn prepare_website_frame_until(
        &self,
        connection: WorkerServiceConnection,
        purpose: WebsitePurpose,
        deadline: Instant,
    ) -> std::result::Result<Frame<'_>, Box<ResourceActorFailure<'_>>> {
        let mut frame = Frame::incoming(self, connection, purpose, deadline);
        match frame.prepare() {
            Ok(()) => Ok(frame),
            Err(cause) => Err(Box::new(ResourceActorFailure { frame, cause })),
        }
    }
}
impl<'a> Frame<'a> {
    fn incoming(
        broker: &'a InstallingBroker,
        connection: WorkerServiceConnection,
        purpose: WebsitePurpose,
        deadline: Instant,
    ) -> Self {
        Self {
            purpose,
            broker,
            snapshot: None,
            transport: Transport::Incoming(connection),
            private: InstalledFactsObserver::default(),
            input: ImmutableInputObserver::default(),
            code: ImmutableCodeObserver::default(),
            aliases: ImmutableAliasObserver::default(),
            processes: WebsiteProcessObserver::default(),
            engine: None,
            context: None,
            bindings: None,
            deadline,
            failed: false,
            frames: 0,
            unconfirmed: None,
            employee_close: None,
        }
    }
}
impl Frame<'_> {
    fn retain(&mut self) -> Result<()> {
        let Transport::Incoming(connection) =
            std::mem::replace(&mut self.transport, Transport::Closed)
        else {
            return Err(ResourceActorError::Refused("RESOURCE_ACTOR_CHANNEL_STATE"));
        };
        let runtime = &self.broker.storage.runtime;
        let retained = match self.purpose {
            WebsitePurpose::RamOperation => connection.retain_resource_website_channel(runtime),
            WebsitePurpose::PoolRegistration => {
                connection.retain_pool_registration_website_channel(runtime)
            }
            WebsitePurpose::FleetPreview => {
                connection.retain_fleet_maintenance_website_channel(runtime)
            }
        };
        match retained {
            Ok(channel) => self.transport = Transport::Retained(channel),
            Err(failure) => {
                self.transport = Transport::Failed(failure);
                return Err(ResourceActorError::Refused("RESOURCE_ACTOR_CHANNEL_ORIGIN"));
            }
        }
        let reports = self.broker.reports.clone();
        let purpose = self.purpose;
        let channel = self.channel()?;
        channel.assert_service(&reports)?;
        channel.pin_peer()?;
        // Version-two wire activation is explicit. Original v1 purpose and
        // persisted installation selectors keep their separate contracts.
        let raw = channel.request_bytes();
        match purpose {
            WebsitePurpose::RamOperation => decode_ram_pool_hello(raw)?,
            WebsitePurpose::PoolRegistration => decode_pool_registration_hello(raw)?,
            WebsitePurpose::FleetPreview => decode_fleet_maintenance_hello(raw)?,
        }
        Ok(())
    }
    fn channel(&mut self) -> Result<&mut WorkerActorChannel> {
        match &mut self.transport {
            Transport::Retained(channel) => Ok(channel),
            _ => Err(ResourceActorError::Refused("RESOURCE_ACTOR_CHANNEL_STATE")),
        }
    }
    fn assert_metadata(&self, end: Instant) -> Result<()> {
        let snapshot = self.assert_configuration_owner(end)?;
        self.private
            .assert_metadata(snapshot.configuration(), end)?;
        Ok(())
    }
    fn assert_configuration_owner(&self, end: Instant) -> Result<&Arc<ValidatedWorkerSnapshot>> {
        need(
            !self.failed && Instant::now() < end && Instant::now() < self.deadline,
            "RESOURCE_ACTOR_CHANNEL_EXPIRED",
        )?;
        let snapshot = self
            .snapshot
            .as_ref()
            .ok_or(ResourceActorError::Refused("RESOURCE_ACTOR_NOT_BOUND"))?;
        need(
            Arc::ptr_eq(snapshot, &self.broker.configuration()?),
            "RESOURCE_ACTOR_CONFIGURATION_CHANGED",
        )?;
        Ok(snapshot)
    }
}
impl InstalledResourceWebsite<'_> {
    /// Full native bootstrap recheck, without constructing an owner grant.
    pub fn assert_current(&mut self) -> Result<()> {
        self.frame.assert_current()
    }
    pub fn close_channel_component(&mut self, end: Instant) -> Result<WorkerLaunchClose> {
        self.frame.close(end)
    }
}
impl InstalledPoolRegistrationWebsite<'_> {
    pub fn assert_current(&mut self) -> Result<()> {
        self.frame.assert_current()
    }
    /// Metadata/channel component only; not registration or pool settlement.
    pub fn close_channel_component(&mut self, end: Instant) -> Result<WorkerLaunchClose> {
        self.frame.close(end)
    }
}
impl Frame<'_> {
    fn assert_current(&mut self) -> Result<()> {
        let end = self.deadline.min(Instant::now() + Duration::from_secs(5));
        let result = self.guard_bootstrap(end);
        self.failed |= result.is_err();
        result
    }
}
impl Drop for Frame<'_> {
    fn drop(&mut self) {
        if !matches!(self.transport, Transport::Closed) {
            // Default destruction is not finalization. Preserve the SAME
            // counted accepted record and native producer on uncertainty.
            std::mem::forget(std::mem::replace(&mut self.transport, Transport::Closed));
            std::mem::forget(self.context.take());
            std::mem::forget(self.employee_close.take());
        }
    }
}
