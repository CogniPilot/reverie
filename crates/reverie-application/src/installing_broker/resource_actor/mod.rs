//! Native protected website channel for the actual installing broker. Its
//! constructor has no wire-selected engine/program, callbacks or owner flag.
//! Qualifying a website does not authorize an employee resource operation.
mod error;
mod operation;
mod qualification;
#[cfg(test)]
mod tests;
mod wire;
use super::*;
use crate::reservation_observer::ObservationContext;
pub use error::{ResourceActorError, ResourceActorFailure};
use error::{Result, need};
pub use operation::AuthenticatedResourceOperation;
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
struct Frame<'a> {
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
}
#[must_use = "retain this exact protected channel through actual operation and checked close"]
pub struct InstalledResourceWebsite<'a> {
    frame: Frame<'a>,
}
impl InstallingBroker {
    /// Actual accepted Q connection only. The early same counted hold and
    /// kernel peer precede all immutable/private/native qualification.
    pub fn prepare_resource_website(
        &self,
        connection: WorkerServiceConnection,
    ) -> std::result::Result<InstalledResourceWebsite<'_>, Box<ResourceActorFailure<'_>>> {
        let mut frame = Frame {
            broker: self,
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
            deadline: Instant::now() + Duration::from_secs(300),
            failed: false,
            frames: 0,
        };
        match frame.prepare() {
            Ok(()) => Ok(InstalledResourceWebsite { frame }),
            Err(cause) => Err(Box::new(ResourceActorFailure { frame, cause })),
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
        match connection.retain_resource_website_channel(&self.broker.storage.runtime) {
            Ok(channel) => self.transport = Transport::Retained(channel),
            Err(failure) => {
                self.transport = Transport::Failed(failure);
                return Err(ResourceActorError::Refused("RESOURCE_ACTOR_CHANNEL_ORIGIN"));
            }
        }
        let reports = self.broker.reports.clone();
        let channel = self.channel()?;
        channel.assert_service(&reports)?;
        channel.pin_peer()?;
        // Version-two wire activation is explicit. Original v1 purpose and
        // persisted installation selectors keep their separate contracts.
        decode_ram_pool_hello(channel.request_bytes())?;
        Ok(())
    }
    fn channel(&mut self) -> Result<&mut WorkerActorChannel> {
        match &mut self.transport {
            Transport::Retained(channel) => Ok(channel),
            _ => Err(ResourceActorError::Refused("RESOURCE_ACTOR_CHANNEL_STATE")),
        }
    }
    fn assert_metadata(&self, end: Instant) -> Result<()> {
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
        self.private
            .assert_metadata(snapshot.configuration(), end)?;
        Ok(())
    }
    fn close(&mut self, end: Instant) -> Result<WorkerLaunchClose> {
        self.failed = true;
        // Attempt every original producer settlement even if another reader's
        // close was uncertain. Never release the SAME channel hold unless all
        // results establish known finalization; preserve every failing cause.
        let readers: [Result<()>; 7] = [
            self.private.assert_finalized().map_err(Into::into),
            self.input.assert_finalized().map_err(Into::into),
            self.code.assert_finalized().map_err(Into::into),
            self.aliases.assert_finalized().map_err(Into::into),
            self.processes.assert_finalized().map_err(Into::into),
            self.engine.as_ref().map_or(Ok(()), |engine| {
                engine.assert_finalized().map_err(Into::into)
            }),
            self.context.as_ref().map_or(Ok(()), |context| {
                context.settle_metadata_owned(end).map_err(Into::into)
            }),
        ];
        let readers = readers.into_iter().fold(Ok(()), error::finalized);
        let disconnected = match &mut self.transport {
            Transport::Retained(channel) => channel
                .disconnect_for_worker()
                .map(|_| ())
                .map_err(Into::into),
            _ => Ok(()),
        };
        error::finalized(readers, disconnected)?;
        let closed = match &mut self.transport {
            Transport::Retained(channel) => channel.close_for_worker()?,
            Transport::Failed(failure) => {
                failure.close_for_worker()?;
                WorkerLaunchClose::SocketClosedHandlerRetained
            }
            Transport::Incoming(connection) => {
                connection.close_socket_for_worker()?;
                WorkerLaunchClose::SocketClosedHandlerRetained
            }
            Transport::Closed => {
                return Err(ResourceActorError::Refused("RESOURCE_ACTOR_CHANNEL_CLOSED"));
            }
        };
        self.transport = Transport::Closed;
        self.context = None;
        Ok(closed)
    }
}
impl InstalledResourceWebsite<'_> {
    /// Full native bootstrap recheck, without constructing an owner grant.
    pub fn assert_current(&mut self) -> Result<()> {
        let end = self
            .frame
            .deadline
            .min(Instant::now() + Duration::from_secs(5));
        let result = self.frame.guard_bootstrap(end);
        self.frame.failed |= result.is_err();
        result
    }
    pub fn close_channel_component(&mut self, end: Instant) -> Result<WorkerLaunchClose> {
        self.frame.close(end)
    }
}
impl Drop for Frame<'_> {
    fn drop(&mut self) {
        if !matches!(self.transport, Transport::Closed) {
            // Default destruction is not finalization. Preserve the SAME
            // counted accepted record and native producer on uncertainty.
            std::mem::forget(std::mem::replace(&mut self.transport, Transport::Closed));
            std::mem::forget(self.context.take());
        }
    }
}
