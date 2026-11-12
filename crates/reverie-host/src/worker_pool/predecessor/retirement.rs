//! Retire the stopped controller by original CID under one durable intent.
use super::*;
use crate::{
    captured_client::CapturedCall,
    private_pending::{PendingError, PendingFile},
};
use serde::Serialize;
use sha2::{Digest, Sha256};

const PURPOSE: &str = "reverie-installed-pool-controller-retirement-v1";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PoolPredecessorRetirementPhase {
    BeforeIntent,
    IntentUnconfirmed,
    IntentPublished,
    RenameUnconfirmed,
}

#[must_use = "retain the original stopped predecessor and its pending intent"]
pub struct PendingPoolPredecessorRetirement(Attempt);

#[must_use = "retain the original fences through socket retirement and handoff"]
pub struct RenamedPoolPredecessor(Attempt);

#[must_use = "retain the original retirement and its unresolved native call"]
pub struct PoolPredecessorRetirementFailure {
    attempt: Attempt,
    cause: Cause,
}

#[derive(Debug)]
enum Cause {
    Predecessor(PoolPredecessorError),
    Publish(PendingError),
    Pending(PendingError),
}

struct Attempt {
    predecessor: PreparedPoolPredecessor,
    original_name: String,
    retired_name: String,
    pending: Option<PendingFile>,
    call: Option<CapturedCall>,
    phase: PoolPredecessorRetirementPhase,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Intent<'a> {
    version: u32,
    purpose: &'static str,
    configuration_digest: String,
    controller_id: &'a str,
    controller_birth_digest: &'a str,
    controller_exit_code: u8,
    original_name: &'a str,
    retired_name: &'a str,
    original_inspection_sha256: String,
    retained_anchor: &'a RetainedPoolAnchor,
}

impl PreparedPoolPredecessor {
    pub fn begin_retirement(
        self,
    ) -> std::result::Result<PendingPoolPredecessorRetirement, Box<PoolPredecessorRetirementFailure>>
    {
        let original_name = self.namespace.birth().identity().policy().controller_name();
        let retired_name = format!("{original_name}-retired-{}", self.controller_id().as_str());
        let mut attempt = Attempt {
            predecessor: self,
            original_name,
            retired_name,
            pending: None,
            call: None,
            phase: PoolPredecessorRetirementPhase::BeforeIntent,
        };
        match attempt.prepare() {
            Ok(()) => Ok(PendingPoolPredecessorRetirement(attempt)),
            Err(cause) => Err(Box::new(PoolPredecessorRetirementFailure {
                attempt,
                cause,
            })),
        }
    }
}

impl PendingPoolPredecessorRetirement {
    pub fn rename_controller(
        mut self,
    ) -> std::result::Result<RenamedPoolPredecessor, Box<PoolPredecessorRetirementFailure>> {
        match self.0.rename() {
            Ok(()) => Ok(RenamedPoolPredecessor(self.0)),
            Err(cause) => Err(Box::new(PoolPredecessorRetirementFailure {
                attempt: self.0,
                cause,
            })),
        }
    }
}

impl RenamedPoolPredecessor {
    pub fn controller_id(&self) -> &ContainerId {
        self.0.predecessor.controller_id()
    }

    pub fn retired_name(&self) -> &str {
        &self.0.retired_name
    }

    pub fn retained_anchor(&self) -> &RetainedPoolAnchor {
        self.0.predecessor.retained_anchor()
    }

    pub fn has_socket(&self) -> bool {
        self.0.predecessor.has_socket()
    }
}

impl Attempt {
    fn prepare(&mut self) -> std::result::Result<(), Cause> {
        self.assert_before_rename()?;
        let raw = self.encode_intent()?;
        self.predecessor.fences()?;
        self.predecessor.assert_source_current()?;
        self.phase = PoolPredecessorRetirementPhase::IntentUnconfirmed;
        let policy = self.predecessor.namespace.birth().identity().policy();
        let pending = self
            .predecessor
            .namespace
            .publish_retirement_pending(policy, &raw)
            .map_err(Cause::Publish)?;
        self.pending = Some(pending);
        self.phase = PoolPredecessorRetirementPhase::IntentPublished;
        self.assert_pending()
    }

    fn rename(&mut self) -> std::result::Result<(), Cause> {
        self.assert_pending()?;
        self.assert_before_rename()?;
        self.assert_pending()?;
        let service = &self.predecessor.service;
        service
            .assert_publication_current(service.source())
            .map_err(PoolPredecessorError::Service)?;
        self.predecessor.time()?;
        self.phase = PoolPredecessorRetirementPhase::RenameUnconfirmed;
        let id = self.predecessor.controller_id();
        self.predecessor
            .engine
            .rename_controller(id, &self.retired_name, &mut self.call)?;
        self.assert_pending()?;
        self.predecessor
            .check_current_name(Some(&self.retired_name))?;
        self.assert_pending()
    }

    fn assert_before_rename(&mut self) -> Checked<()> {
        self.predecessor.assert_current()?;
        self.predecessor.engine.assert_name_pair(
            self.predecessor.controller_id(),
            &self.original_name,
            &self.retired_name,
        )?;
        self.predecessor.fences()?;
        self.predecessor.assert_source_current()?;
        Ok(())
    }

    fn assert_pending(&self) -> std::result::Result<(), Cause> {
        self.pending
            .as_ref()
            .expect("original retirement intent was published")
            .assert_current()
            .map_err(Cause::Pending)
    }

    fn encode_intent(&self) -> Result<Vec<u8>> {
        let selected = &self.predecessor;
        let configuration = worker_config::decode(selected.source().bytes())
            .map_err(|_| PoolError::Refused("WORKER_POOL_PREDECESSOR_SOURCE_DATA"))?;
        let intent = Intent {
            version: 1,
            purpose: PURPOSE,
            configuration_digest: worker_config::config_digest(&configuration).to_hex(),
            controller_id: selected.controller_id().as_str(),
            controller_birth_digest: selected.birth_digest().as_str(),
            controller_exit_code: selected.exit_code(),
            original_name: &self.original_name,
            retired_name: &self.retired_name,
            original_inspection_sha256: format!("{:x}", Sha256::digest(&selected.controller().raw)),
            retained_anchor: selected.retained_anchor(),
        };
        serde_json::to_vec(&intent).map_err(|_| PoolError::Refused("WORKER_POOL_RETIREMENT_INTENT"))
    }
}

impl From<PoolPredecessorError> for Cause {
    fn from(error: PoolPredecessorError) -> Self {
        Self::Predecessor(error)
    }
}

impl From<PoolError> for Cause {
    fn from(error: PoolError) -> Self {
        Self::Predecessor(error.into())
    }
}

impl PoolPredecessorRetirementFailure {
    pub fn phase(&self) -> PoolPredecessorRetirementPhase {
        self.attempt.phase
    }

    pub fn code(&self) -> &'static str {
        match &self.cause {
            Cause::Predecessor(PoolPredecessorError::Pool(error)) => error.code(),
            Cause::Predecessor(PoolPredecessorError::Service(error)) => error.code(),
            Cause::Predecessor(PoolPredecessorError::Files(error)) => error.code(),
            Cause::Publish(PendingError::Io(error))
                if error.kind() == io::ErrorKind::AlreadyExists =>
            {
                "WORKER_POOL_RETIREMENT_PENDING_EXISTS"
            }
            Cause::Publish(_) => "WORKER_POOL_RETIREMENT_PENDING_UNCONFIRMED",
            Cause::Pending(error) => match error {
                PendingError::Io(error) if error.kind() != io::ErrorKind::NotFound => {
                    "WORKER_POOL_RETIREMENT_PENDING_UNAVAILABLE"
                }
                _ => "WORKER_POOL_RETIREMENT_PENDING_CHANGED",
            },
        }
    }

    /// Settle only the retained local command. This leaves the Docker outcome
    /// and original retirement intent available for checked reconciliation.
    pub fn settle_native_call(&mut self) -> Result<()> {
        if let Some(call) = &self.attempt.call {
            self.attempt.predecessor.engine.settle_rename(call)?;
            self.attempt.call = None;
        }
        Ok(())
    }
}

impl fmt::Debug for PoolPredecessorRetirementFailure {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output
            .debug_struct("PoolPredecessorRetirementFailure")
            .field("phase", &self.phase())
            .field("cause", &self.cause)
            .finish()
    }
}

impl fmt::Display for PoolPredecessorRetirementFailure {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str(self.code())
    }
}

impl std::error::Error for PoolPredecessorRetirementFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match &self.cause {
            Cause::Predecessor(error) => Some(error),
            Cause::Publish(_) | Cause::Pending(_) => None,
        }
    }
}
