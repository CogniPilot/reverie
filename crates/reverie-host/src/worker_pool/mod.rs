//! Docker-controller cgroup ownership. Public policy/anchor values are data;
//! the installed witness retains the actual opened kernel directory. This is
//! not a Gate, storage lease, stop receipt or global shutdown acknowledgement.
mod bootstrap;
mod client;
#[cfg(test)]
mod close_classification_tests;
mod controller_limits;
pub use client::{
    ActivatedController, ControllerActivationFailure, ControllerCapacity, ControllerStatusData,
};
pub(crate) mod directory;
mod endpoint;
mod engine;
mod image_inputs_reference;
pub use image_inputs_reference::{
    compiled_pool_image_inputs_reference, compiled_previous_pool_image_inputs_reference,
};
mod installation_request;
pub use installation_request::load_os_pool_installation_request;
pub use installation_request::{
    PoolNominationError, PoolNominationFailure, PoolNominationPublished,
    PoolNominationRevisionFailure, publish_current_os_pool_nomination, publish_os_pool_nomination,
    retire_failed_os_pool_installation, revise_os_pool_nomination,
};
mod member;
mod namespace;
mod policy;
mod publication;
mod service;
mod target_observation;
pub use target_observation::{PoolTargetObservation, PoolTargetObservationError, PoolTargetPhase};
#[cfg(test)]
#[path = "target_observation/tests.rs"]
mod target_observation_tests;
pub use service::{ControllerServing, ControllerServingFailure};
#[cfg(test)]
mod tests;
pub use crate::worker_laptop::PoolMemberCreation;
pub use bootstrap::{BrokerBootstrapBinding, BrokerBootstrapFailure};
use directory::PoolDirectory;
pub use endpoint::{
    ControllerEndpoint, ControllerEndpointFailure, ControllerPeer, ControllerPeerFailure,
};
pub use member::{OpenedPoolMember, PoolMemberFailure, PoolMemberLimits};
pub use policy::{ControllerPoolPolicy, ControllerPoolPolicyFailure};
pub use publication::{ControllerBirthPublication, PublishedControllerBirthData};
use reverie_contracts::worker_pool::WorkerPoolPolicy;
use std::{fmt, io};

#[derive(Debug)]
pub enum PoolError {
    Refused(&'static str),
    Io(io::Error),
    Observation(crate::ObservationError),
    Finalization(Box<PoolError>, Box<PoolError>),
    MetadataClose(Box<PoolError>),
    BootstrapFacts(Box<crate::website_facts::WebsiteFactsError>),
    Engine(crate::engine_metadata::EngineError),
    Member(std::sync::Arc<crate::worker_laptop::LaptopError>),
    Channel(crate::worker_reports::WorkerReportError),
    CreationBudget(reverie_contracts::creation_budget::CreationBudgetError),
    CreationDeadline,
}
impl fmt::Display for PoolError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str(self.code())
    }
}
impl std::error::Error for PoolError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Observation(error) => Some(error),
            Self::Finalization(primary, _) => Some(primary),
            Self::MetadataClose(error) => Some(error),
            Self::BootstrapFacts(error) => Some(error),
            Self::Engine(error) => Some(error),
            Self::Member(error) => Some(error.as_ref()),
            Self::Channel(error) => Some(error),
            Self::CreationBudget(error) => Some(error),
            Self::Refused(_) | Self::CreationDeadline => None,
        }
    }
}
impl PoolError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Refused(code) => code,
            Self::Io(_) => "WORKER_POOL_IO_UNKNOWN",
            Self::Observation(_) => "WORKER_POOL_CLOSE_UNKNOWN",
            Self::Finalization(_, _) => "WORKER_POOL_FINALIZATION_UNKNOWN",
            Self::MetadataClose(_) => "WORKER_POOL_CLOSE_UNKNOWN",
            Self::BootstrapFacts(error) => error.code(),
            Self::Engine(_) => "WORKER_POOL_CAPTURED_ENGINE",
            Self::Member(error) => error.code(),
            Self::Channel(error) => error.code(),
            Self::CreationBudget(error) => error.code(),
            Self::CreationDeadline => "WORKER_POOL_CREATION_BUDGET_DEADLINE",
        }
    }
    pub(crate) fn close_unknown(&self) -> bool {
        match self {
            Self::MetadataClose(_) => true,
            Self::Observation(error) => error.has_unconfirmed_close(),
            Self::Member(error) => error.unconfirmed_native(),
            Self::Channel(error) => error.has_unconfirmed_close(),
            Self::Finalization(primary, secondary) => {
                primary.close_unknown() || secondary.close_unknown()
            }
            _ => false,
        }
    }
}
impl From<io::Error> for PoolError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}
impl From<crate::ObservationError> for PoolError {
    fn from(error: crate::ObservationError) -> Self {
        Self::Observation(error)
    }
}
type Result<T> = std::result::Result<T, PoolError>;
fn need(value: bool, code: &'static str) -> Result<()> {
    value.then_some(()).ok_or(PoolError::Refused(code))
}
fn finalized<T>(result: Result<T>, closed: Result<()>) -> Result<T> {
    match (result, closed) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) => Err(error),
        (Ok(_), Err(error)) => Err(PoolError::MetadataClose(Box::new(error))),
        (Err(primary), Err(secondary)) => Err(PoolError::Finalization(
            Box::new(primary),
            Box::new(PoolError::MetadataClose(Box::new(secondary))),
        )),
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum InstallationStage {
    Opening,
    Ready,
    Attempted,
    Confirmed,
    Refused,
    Closing,
    Closed,
}

/// Owns the actual controller policy and kernel directory before the first
/// write. A failed or partial attempt cannot be retried through this owner.
pub struct OpenedWorkerPool {
    policy: ControllerPoolPolicy,
    directory: PoolDirectory,
    anchor_id: String,
    anchor_pid: u32,
    stage: InstallationStage,
}

impl OpenedWorkerPool {
    /// Called by the fixed controller after its own exact Docker anchor
    /// construction and maintenance fence. This independently checks actual
    /// proc membership and kernel filesystem identity before adopting a root.
    pub fn capture_anchor(
        policy: ControllerPoolPolicy,
        anchor_id: &str,
        anchor_pid: u32,
    ) -> std::result::Result<Self, Box<PoolCaptureFailure>> {
        let directory = PoolDirectory::unopened(policy.data());
        let mut owner = Self {
            policy,
            directory,
            anchor_id: anchor_id.into(),
            anchor_pid,
            stage: InstallationStage::Opening,
        };
        let result = (|| {
            owner.policy.assert_current()?;
            need(
                reverie_contracts::worker_pool::hex_id(anchor_id) && anchor_pid > 1,
                "WORKER_POOL_ANCHOR_IDENTITY",
            )?;
            owner.policy.assert_anchor(anchor_id, anchor_pid)?;
            owner
                .directory
                .acquire(owner.policy.data(), anchor_id, anchor_pid)
        })();
        match result {
            Ok(()) => {
                owner.stage = InstallationStage::Ready;
                Ok(owner)
            }
            Err(primary) => {
                owner.stage = InstallationStage::Refused;
                Err(Box::new(PoolCaptureFailure { owner, primary }))
            }
        }
    }

    /// One-shot controller effect, with all opened owners already retained.
    /// The application must still retain its real provider-maintenance fence.
    pub fn initialize(&mut self) -> Result<()> {
        // The new serving purpose cannot reuse this lower v1 component
        // effect as a substitute for genuine Q/provider maintenance.
        self.policy.require_component_initialization()?;
        need(
            self.stage == InstallationStage::Ready,
            "WORKER_POOL_ATTEMPT_ALREADY_EXISTS",
        )?;
        self.policy.assert_current()?;
        self.policy
            .assert_anchor(&self.anchor_id, self.anchor_pid)?;
        self.directory
            .assert_anchor_only(&self.anchor_id, self.anchor_pid)?;
        self.stage = InstallationStage::Attempted;
        self.directory.configure(self.policy.data())?;
        self.policy.assert_current()?;
        self.policy
            .assert_anchor(&self.anchor_id, self.anchor_pid)?;
        self.directory
            .assert_anchor_only(&self.anchor_id, self.anchor_pid)?;
        self.directory.assert_limits(self.policy.data())?;
        self.stage = InstallationStage::Confirmed;
        Ok(())
    }

    pub fn installed(&self) -> Result<InstalledWorkerPool<'_>> {
        need(
            self.stage == InstallationStage::Confirmed,
            "WORKER_POOL_INSTALLATION_UNKNOWN",
        )?;
        self.policy.assert_current()?;
        self.policy
            .assert_anchor(&self.anchor_id, self.anchor_pid)?;
        self.directory
            .assert_anchor_current(&self.anchor_id, self.anchor_pid)?;
        self.directory.assert_limits(self.policy.data())?;
        Ok(InstalledWorkerPool {
            policy: &self.policy,
            directory: &self.directory,
            anchor_id: &self.anchor_id,
            anchor_pid: self.anchor_pid,
            stage: &self.stage,
        })
    }

    pub fn close(&mut self) -> Result<()> {
        // Terminal before any fallible close: neither stale installed borrows
        // nor a previously Confirmed stage may perform forward observations.
        self.stage = InstallationStage::Closing;
        let directory = self.directory.close();
        finalized(directory, self.policy.close())?;
        self.stage = InstallationStage::Closed;
        Ok(())
    }
}

/// The actual partially opened owner is returned on capture refusal. No
/// caller-supplied error/ID can certify that its descriptors were finalized.
pub struct PoolCaptureFailure {
    owner: OpenedWorkerPool,
    primary: PoolError,
}
impl PoolCaptureFailure {
    pub fn primary_error(&self) -> &PoolError {
        &self.primary
    }
    pub fn close(&mut self) -> Result<()> {
        self.owner.close()
    }
}

/// Borrow of the actual retained controller/kernel owner. No serde constructor
/// or reply/ID conversion can create this witness.
pub struct InstalledWorkerPool<'a> {
    policy: &'a ControllerPoolPolicy,
    directory: &'a PoolDirectory,
    anchor_id: &'a str,
    anchor_pid: u32,
    stage: &'a InstallationStage,
}
impl<'a> InstalledWorkerPool<'a> {
    fn borrow_view(&self) -> Self {
        Self {
            policy: self.policy,
            directory: self.directory,
            anchor_id: self.anchor_id,
            anchor_pid: self.anchor_pid,
            stage: self.stage,
        }
    }
    pub fn reobserve(&self) -> Result<()> {
        need(
            *self.stage == InstallationStage::Confirmed,
            "WORKER_POOL_INSTALLATION_UNKNOWN",
        )?;
        self.policy.assert_current()?;
        self.policy.assert_anchor(self.anchor_id, self.anchor_pid)?;
        self.directory
            .assert_anchor_current(self.anchor_id, self.anchor_pid)?;
        self.directory.assert_limits(self.policy.data())
    }
    pub fn policy_data(&self) -> &WorkerPoolPolicy {
        self.policy.data()
    }
    pub fn kernel_identity(&self) -> (u64, u64) {
        self.directory.identity()
    }
}
