//! An installed predecessor observation retaining the original maintenance
//! owners. It offers no container, socket, or policy mutation.
use super::*;
use crate::{
    engine_metadata::{CancellationToken, EngineQuery, MetadataQueryOwner},
    native,
    website_facts::ImmutableInputObserver,
    worker_image::{
        ImageControlFiles, ImageFileError, ImageMaintenanceLocks, ImagePrivateSnapshot,
    },
    worker_runtime::{WorkerRuntime, WorkerStopBudget},
    worker_service::{ImageServiceMaintenance, WorkerServiceError},
};
use reverie_contracts::{
    worker_config::{self, EffectiveWorkerConfig},
    worker_pool::{ControllerServiceBirth, RetainedPoolAnchor, WorkerPoolProvider},
    worker_recovery::RecoveryInspection,
};
use reverie_core::{ids::ContainerId, operations::JournalDigest};
use std::{path::Path, time::Instant};

mod anchor;
mod engine;
mod namespace;

#[derive(Debug)]
pub enum PoolPredecessorError {
    Pool(PoolError),
    Service(WorkerServiceError),
    Files(ImageFileError),
}
impl fmt::Display for PoolPredecessorError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Pool(error) => error.fmt(output),
            Self::Service(error) => error.fmt(output),
            Self::Files(error) => error.fmt(output),
        }
    }
}
impl std::error::Error for PoolPredecessorError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Pool(error) => Some(error),
            Self::Service(error) => Some(error),
            Self::Files(error) => Some(error),
        }
    }
}
impl From<PoolError> for PoolPredecessorError {
    fn from(error: PoolError) -> Self {
        Self::Pool(error)
    }
}

type Checked<T> = std::result::Result<T, PoolPredecessorError>;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Opening,
    Observed,
    Failed,
    Closing,
    Closed,
    CloseUnknown,
}

#[must_use = "retain the exact stopped controller and finish its observation"]
pub struct PreparedPoolPredecessor {
    service: ImageServiceMaintenance,
    locks: ImageMaintenanceLocks,
    reader: ImageControlFiles,
    source: Option<ImagePrivateSnapshot>,
    engine: engine::Engine,
    namespace: namespace::Namespace,
    immutable: ImmutableInputObserver,
    controller: Option<engine::Controller>,
    anchor: Option<anchor::Anchor>,
    phase: Phase,
    source_close_unknown: bool,
}

#[must_use = "retain the original partial predecessor observations"]
pub struct PoolPredecessorFailure {
    owner: PreparedPoolPredecessor,
    primary: PoolPredecessorError,
}
impl fmt::Debug for PoolPredecessorFailure {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output
            .debug_tuple("PoolPredecessorFailure")
            .field(&self.primary)
            .finish()
    }
}
impl fmt::Display for PoolPredecessorFailure {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.primary.fmt(output)
    }
}
impl std::error::Error for PoolPredecessorFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.primary)
    }
}
impl PoolPredecessorFailure {
    pub fn primary_error(&self) -> &PoolPredecessorError {
        &self.primary
    }
    pub fn close_components(&mut self) -> Result<()> {
        self.owner.close_components()
    }

    /// Return both original maintenance owners after known component close.
    pub fn into_closed_guards(
        self: Box<Self>,
    ) -> std::result::Result<(ImageServiceMaintenance, ImageMaintenanceLocks), Box<Self>> {
        if self.owner.phase != Phase::Closed {
            return Err(self);
        }
        Ok((self.owner.service, self.owner.locks))
    }
}

impl PreparedPoolPredecessor {
    pub fn prepare(
        runtime: &WorkerRuntime,
        service: ImageServiceMaintenance,
        locks: ImageMaintenanceLocks,
        configuration: &EffectiveWorkerConfig,
        end: Instant,
    ) -> std::result::Result<Self, Box<PoolPredecessorFailure>> {
        let mut owner = Self {
            reader: ImageControlFiles::capture(service.source(), configuration),
            engine: engine::Engine::new(runtime, end.min(service.end()).min(locks.end())),
            service,
            locks,
            source: None,
            namespace: namespace::Namespace::default(),
            immutable: ImmutableInputObserver::default(),
            controller: None,
            anchor: None,
            phase: Phase::Opening,
            source_close_unknown: false,
        };
        match owner.observe(configuration) {
            Ok(()) => {
                owner.phase = Phase::Observed;
                Ok(owner)
            }
            Err(primary) => {
                owner.phase = Phase::Failed;
                Err(Box::new(PoolPredecessorFailure { owner, primary }))
            }
        }
    }

    fn observe(&mut self, configuration: &EffectiveWorkerConfig) -> Checked<()> {
        self.fences()?;
        self.source = Some(self.read_source()?);
        let captured = worker_config::decode(self.source().bytes())
            .map_err(|_| PoolError::Refused("WORKER_POOL_PREDECESSOR_SOURCE_DATA"))?;
        need(
            worker_config::equivalent(&captured, configuration),
            "WORKER_POOL_PREDECESSOR_SOURCE_CHANGED",
        )?;
        let provider = WorkerPoolProvider::from_config(&captured)
            .map_err(|_| PoolError::Refused("WORKER_POOL_PROVIDER_INVALID"))?
            .ok_or(PoolError::Refused("WORKER_POOL_PROVIDER_REQUIRED"))?;
        let policy = provider.policy();
        let home = native::python_path(&native::home_directory(None).map_err(PoolError::Io)?)
            .map_err(PoolError::Io)?;
        need(
            Path::new(&policy.instance_root) == home.join("reverie"),
            "WORKER_POOL_PREDECESSOR_INSTANCE_ROOT",
        )?;
        self.controller = Some(engine::Controller::observe(policy, &self.engine)?);
        self.capture_birth_and_anchor(policy)?;
        self.check_current()
    }

    fn capture_birth_and_anchor(&mut self, policy: &WorkerPoolPolicy) -> Result<()> {
        let original = self.controller.as_ref().expect("observed controller");
        self.namespace.capture(policy, original.digest.as_str())?;
        let service_birth = self.namespace.birth();
        let birth = service_birth.identity();
        engine::assert_inactive(birth.broker().pid(), &original.id)?;
        bootstrap::assert_predecessor_source(birth, self.service.source())?;
        let identity = self
            .immutable
            .observe_broker_program(birth.program(), self.engine.deadline())
            .map_err(|error| PoolError::BootstrapFacts(Box::new(error)))?;
        need(
            identity.identity() == birth.broker().executable_identity(),
            "WORKER_POOL_PREDECESSOR_BROKER_EXECUTABLE_CHANGED",
        )?;
        self.anchor = Some(anchor::Anchor::unopened(policy));
        self.anchor
            .as_mut()
            .expect("retained original anchor owner")
            .observe(
                &self.engine,
                policy,
                &original.digest,
                service_birth.retained_anchor(),
            )
    }

    /// A failed bracket invalidates this observation. Only its checked close
    /// remains available on the original owner.
    pub fn assert_current(&mut self) -> Checked<()> {
        need(
            self.phase == Phase::Observed,
            "WORKER_POOL_PREDECESSOR_UNAVAILABLE",
        )?;
        let result = self.check_current();
        if result.is_err() {
            self.phase = Phase::Failed;
        }
        result
    }

    fn check_current(&mut self) -> Checked<()> {
        self.fences()?;
        self.assert_source_current()?;
        let original = self.controller();
        let birth = self.namespace.birth().identity();
        engine::assert_inactive(birth.broker().pid(), &original.id)?;
        let current = engine::Controller::observe(birth.policy(), &self.engine)?;
        need(
            original.id == current.id
                && original.digest == current.digest
                && RecoveryInspection::same_container_object_inspection(
                    original.id.as_str(),
                    &original.raw,
                    &current.raw,
                )
                .map_err(|_| PoolError::Refused("WORKER_POOL_PREDECESSOR_INSPECTION"))?,
            "WORKER_POOL_PREDECESSOR_CONTROLLER_CHANGED",
        )?;
        self.anchor
            .as_ref()
            .expect("observed anchor")
            .assert_current(&self.engine, birth.policy())?;
        engine::assert_inactive(birth.broker().pid(), &original.id)?;
        self.namespace
            .assert_current(birth.policy(), original.digest.as_str())?;
        self.fences()?;
        self.assert_source_current()?;
        self.time().map_err(Into::into)
    }

    fn fences(&mut self) -> Checked<()> {
        self.time()?;
        need(
            self.service.source() == self.locks.source(),
            "WORKER_POOL_PREDECESSOR_SOURCE_CHANGED",
        )?;
        self.service
            .revalidate()
            .map_err(PoolPredecessorError::Service)?;
        self.locks
            .assert_held_current()
            .map_err(PoolPredecessorError::Files)?;
        self.time().map_err(Into::into)
    }

    fn read_source(&mut self) -> Checked<ImagePrivateSnapshot> {
        self.reader.read_configuration().map_err(|error| {
            self.source_close_unknown |= error.has_unconfirmed_close();
            PoolPredecessorError::Files(error)
        })
    }

    fn assert_source_current(&mut self) -> Checked<()> {
        let current = self.read_source()?;
        need(
            current.bytes() == self.source().bytes() && current.stamp() == self.source().stamp(),
            "WORKER_POOL_PREDECESSOR_SOURCE_CHANGED",
        )
        .map_err(Into::into)
    }

    fn source(&self) -> &ImagePrivateSnapshot {
        self.source.as_ref().expect("observed predecessor source")
    }
    fn controller(&self) -> &engine::Controller {
        self.controller
            .as_ref()
            .expect("observed predecessor controller")
    }
    fn time(&self) -> Result<()> {
        need(
            Instant::now() < self.engine.deadline(),
            "WORKER_POOL_PREDECESSOR_DEADLINE",
        )
    }

    pub fn controller_id(&self) -> &ContainerId {
        &self.controller().id
    }
    pub fn birth_digest(&self) -> &JournalDigest {
        &self.controller().digest
    }
    pub fn exit_code(&self) -> u8 {
        self.controller().exit_code
    }
    pub fn has_socket(&self) -> bool {
        self.namespace.has_socket()
    }
    pub fn retained_anchor(&self) -> &RetainedPoolAnchor {
        self.anchor.as_ref().expect("observed anchor").data()
    }

    /// Checked metadata close. The original service fence and file locks stay
    /// live in the returned values for the caller's next guarded phase.
    pub fn close(
        mut self,
    ) -> std::result::Result<
        (ImageServiceMaintenance, ImageMaintenanceLocks),
        Box<PoolPredecessorFailure>,
    > {
        match self.close_components() {
            Ok(()) => Ok((self.service, self.locks)),
            Err(error) => Err(Box::new(PoolPredecessorFailure {
                owner: self,
                primary: error.into(),
            })),
        }
    }

    fn close_components(&mut self) -> Result<()> {
        match self.phase {
            Phase::Closed => return Ok(()),
            Phase::Closing | Phase::CloseUnknown => {
                return Err(PoolError::Refused("WORKER_POOL_PREDECESSOR_CLOSE_UNKNOWN"));
            }
            Phase::Opening | Phase::Observed | Phase::Failed => (),
        }
        self.phase = Phase::Closing;
        let query = self.engine.settle();
        let immutable = self
            .immutable
            .assert_finalized()
            .map_err(|error| PoolError::BootstrapFacts(Box::new(error)));
        let anchor = self.anchor.as_mut().map_or(Ok(()), anchor::Anchor::close);
        let result = finalized(
            query,
            finalized(anchor, finalized(self.namespace.close(), immutable)),
        );
        let result = finalized(
            result,
            need(
                !self.source_close_unknown,
                "WORKER_POOL_PREDECESSOR_SOURCE_CLOSE_UNKNOWN",
            ),
        );
        self.phase = if result.is_ok() {
            Phase::Closed
        } else {
            Phase::CloseUnknown
        };
        result
    }
}
