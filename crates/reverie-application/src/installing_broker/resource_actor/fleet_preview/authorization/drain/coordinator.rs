//! One actual migration attempt, retaining every original owner on failure.
//! No native stop/activation/publication is retried by this owner.
use super::*;
use crate::reservation_gate::{AdmissionBounds, PoolMigrationPublished, PoolTransitionFailure};
use reverie_host::worker_pool::ActivatedController;
use reverie_host::worker_reports::WorkerOriginalHandlersDrain;
mod error;
mod originals;
use error::MigrationCause;

struct Execution<'a> {
    broker: &'a Arc<InstallingBroker>,
    authorization: Option<AuthenticatedPoolMigration<'a>>,
    handlers: Option<WorkerOriginalHandlersDrain>,
    fence: Option<PoolTransitionFence>,
    drained: Option<DrainedPoolMigration<'a>>,
    source: Option<BrokerControllerBootstrap>,
    controller: Option<ActivatedController>,
    publication: Option<PoolMigrationPublished>,
    closed: Option<FleetPreviewClosed>,
    handlers_closed: Option<WorkerOriginalHandlersClosed>,
}
#[must_use = "retain the whole original attempt; a failed effect is never replayed"]
pub struct PoolMigrationFailure<'a> {
    owner: Option<Box<Execution<'a>>>,
    cause: Option<MigrationCause<'a>>,
}
pub struct PoolMigrationClosed {
    frame: FleetPreviewClosed,
    original_handlers: WorkerOriginalHandlersClosed,
}
impl PoolMigrationClosed {
    pub fn original_handler_causes(
        &self,
    ) -> &[Rc<reverie_host::worker_reports::WorkerReportError>] {
        self.original_handlers.original_causes()
    }
    pub fn original_handlers(&self) -> &WorkerOriginalHandlersClosed {
        &self.original_handlers
    }
    pub fn primary_error_code(&self) -> Option<&'static str> {
        self.frame.primary_error_code()
    }
}
impl std::fmt::Display for PoolMigrationClosed {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str("FLEET_POOL_CONFIGURED")
    }
}
impl<'a> AuthenticatedPoolMigration<'a> {
    pub(in crate::installing_broker) fn execute(
        self,
        broker: &'a Arc<InstallingBroker>,
    ) -> std::result::Result<PoolMigrationClosed, Box<PoolMigrationFailure<'a>>> {
        let mut owner = Box::new(Execution {
            broker,
            authorization: Some(self),
            handlers: None,
            fence: None,
            drained: None,
            source: None,
            controller: None,
            publication: None,
            closed: None,
            handlers_closed: None,
        });
        match owner.run() {
            Ok(()) => Ok(PoolMigrationClosed {
                frame: owner.closed.take().expect("actual checked Q closure"),
                original_handlers: owner
                    .handlers_closed
                    .take()
                    .expect("same original closed handlers"),
            }),
            Err(cause) => Err(Box::new(PoolMigrationFailure {
                owner: Some(owner),
                cause: Some(cause),
            })),
        }
    }
}
impl<'a> Execution<'a> {
    fn run(&mut self) -> std::result::Result<(), MigrationCause<'a>> {
        let original = self
            .authorization
            .as_ref()
            .expect("actual migration consent")
            .authorization
            .owner
            .frame
            .as_ref()
            .expect("same Q")
            .broker;
        if !std::ptr::eq(original, self.broker.as_ref()) {
            return Err(MigrationCause::Refused("POOL_MIGRATION_FOREIGN_BROKER"));
        }
        self.drain_originals()?;
        let gate = self
            .broker
            .resource_reservations()
            .map_err(MigrationCause::Gate)?
            .ok_or(MigrationCause::Refused("POOL_TRANSITION_GATE_REQUIRED"))?;
        let migration = self.drained.as_mut().expect("same drained migration");
        migration
            .assert_publication_current(gate)
            .map_err(MigrationCause::Authorization)?;
        let (source, reserve) = migration
            .take_activation_source()
            .map_err(MigrationCause::Native)?;
        self.source = Some(source);
        migration
            .assert_publication_current(gate)
            .map_err(MigrationCause::Authorization)?;
        let end = migration.original_deadline();
        self.controller = Some(
            self.source
                .take()
                .expect("original source retained before activation")
                .activate_controller(reserve, end)
                .map_err(MigrationCause::Activation)?,
        );
        self.publication = Some(
            gate.publish_drained_pool(migration, &mut self.controller)
                .map_err(MigrationCause::Gate)?,
        );
        self.complete()
    }
    fn drain_originals(&mut self) -> std::result::Result<(), MigrationCause<'a>> {
        let auth = self
            .authorization
            .as_mut()
            .expect("actual migration consent");
        self.handlers = Some(
            auth.retain_original_handlers()
                .map_err(MigrationCause::Authorization)?,
        );
        let end = auth.authorization.owner.original_end();
        let gate = self
            .broker
            .resource_reservations()
            .map_err(MigrationCause::Gate)?
            .ok_or(MigrationCause::Refused("POOL_TRANSITION_GATE_REQUIRED"))?;
        self.fence = Some(
            gate.establish_pool_transition(
                auth.selection(),
                AdmissionBounds {
                    operation: Some(end),
                    entry: Some(end),
                },
            )
            .map_err(MigrationCause::Transition)?,
        );
        let fence = self.fence.as_mut().expect("actual original fence");
        let handlers = self.handlers.as_mut().expect("actual original handlers");
        auth.bind_original_cleanup(fence, handlers)
            .map_err(MigrationCause::Authorization)?;
        auth.interrupt_original_handlers(fence, handlers)
            .map_err(MigrationCause::Authorization)?;
        originals::advance_and_settle(auth, fence, handlers, self.broker, end)?;
        let closed = match self.handlers.take().expect("same handlers").into_closed() {
            Ok(closed) => closed,
            Err(retained) => {
                self.handlers = Some(*retained);
                return Err(MigrationCause::Refused("POOL_MIGRATION_HANDLERS_RETAINED"));
            }
        };
        self.drained = Some(
            self.authorization
                .take()
                .expect("same migration consent")
                .drain_legacy_fleet(self.broker, self.fence.take().expect("same fence"), closed)
                .map_err(MigrationCause::Drain)?,
        );
        Ok(())
    }
    fn complete(&mut self) -> std::result::Result<(), MigrationCause<'a>> {
        let migration = self.drained.as_mut().expect("actual drained migration");
        let owner = migration.fleet.owner.as_mut().expect("original resources");
        let publication = self
            .publication
            .as_ref()
            .expect("Gate terminal release success");
        let transition = publication.transition();
        let preview = &mut owner.authorization.owner;
        let restore = preview
            .coverage
            .as_ref()
            .expect("approved company")
            .restore_bindings()
            .map_err(MigrationCause::Native)?;
        let frame = preview
            .maintenance_request
            .as_ref()
            .expect("actual migration request")
            .migration_result(
                transition.policy(),
                &reverie_contracts::worker_config::config_digest(transition.after()).to_hex(),
                &transition.after_binding().domain().to_hex(),
                &restore,
            )
            .map_err(|cause| MigrationCause::Native(cause.into()))?;
        // Lifecycle remains denied until the Gate has checked-close/released
        // the original pending. The terminal reply claims no worker restart.
        owner
            .drain
            .finish_transition()
            .map_err(MigrationCause::DrainComponent)?;
        let end = preview.original_end();
        preview
            .frame
            .as_mut()
            .expect("same Q")
            .send(&frame, end)
            .map_err(|cause| MigrationCause::Native(cause.into()))?;
        preview.close_components().map_err(MigrationCause::Native)?;
        let drained = self.drained.take().expect("same completed migration");
        let mut fleet = drained.fleet;
        let owner = fleet.owner.take().expect("same closed original owner");
        let auth = owner.authorization;
        self.handlers_closed = Some(owner.handlers);
        self.closed = Some(FleetPreviewClosed {
            primary: auth.owner.primary.clone(),
            target_cleanup: auth.owner.target_cleanup.clone(),
            frame_cleanup: auth.owner.frame_cleanup.clone(),
        });
        Ok(())
    }
}
impl Drop for PoolMigrationFailure<'_> {
    fn drop(&mut self) {
        std::mem::forget((self.owner.take(), self.cause.take()));
    }
}
