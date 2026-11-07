//! Fixed owner-only G projection over the actual accepted kernel record,
//! selected worker snapshot, original engine capture and anchored private FDs.
mod files;
mod inventory;
mod projection;
#[cfg(test)]
mod tests;
use crate::{
    captured_client::{CapturedCall, Policy},
    engine_metadata::EngineError,
    native,
    worker_reports::{
        WorkerPeer, WorkerServiceConnection, WorkerServicePurpose, terminal::RelayIdentity,
    },
    worker_runtime::WorkerRuntime,
};
use files::{Fingerprint, PrivateBatch};
use reverie_contracts::{
    goal_custody::{GoalCustodyRequest, GoalPrivateConfig, GoalPrivatePath, GoalWorkerSettings},
    worker_config::EffectiveWorkerConfig,
};
use std::{
    collections::BTreeMap,
    fmt, io,
    path::Path,
    sync::{Arc, Mutex},
    time::Instant,
};

#[derive(Debug)]
pub enum GoalCustodyError {
    Refused(&'static str),
    Data(reverie_contracts::goal_custody::GoalDataError),
    Io(io::Error),
    Native(crate::ObservationError),
    Engine(EngineError),
    Cleanup,
}
impl fmt::Display for GoalCustodyError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str(self.code())
    }
}
impl std::error::Error for GoalCustodyError {}
impl GoalCustodyError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Refused(message) => message,
            Self::Data(_) => "Private Goal configuration unavailable",
            Self::Io(_) | Self::Native(_) => "Private Goal entry unavailable",
            Self::Engine(_) => "Current Goal engine inventory unavailable",
            Self::Cleanup => "Private Goal cleanup unconfirmed",
        }
    }
}
impl From<io::Error> for GoalCustodyError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}
impl From<crate::ObservationError> for GoalCustodyError {
    fn from(value: crate::ObservationError) -> Self {
        Self::Native(value)
    }
}
impl From<reverie_contracts::goal_custody::GoalDataError> for GoalCustodyError {
    fn from(value: reverie_contracts::goal_custody::GoalDataError) -> Self {
        Self::Data(value)
    }
}
type Result<T> = std::result::Result<T, GoalCustodyError>;
fn need(value: bool, message: &'static str) -> Result<()> {
    if value {
        Ok(())
    } else {
        Err(GoalCustodyError::Refused(message))
    }
}
pub struct GoalCustodyState {
    configuration_identity: Mutex<Option<Fingerprint>>,
}
impl Default for GoalCustodyState {
    fn default() -> Self {
        Self::new()
    }
}
impl GoalCustodyState {
    pub fn new() -> Self {
        Self {
            configuration_identity: Mutex::new(None),
        }
    }
    pub fn begin(
        self: &Arc<Self>,
        runtime: &WorkerRuntime,
        connection: &WorkerServiceConnection,
    ) -> Result<GoalCustodyAttempt> {
        need(
            connection.purpose() == WorkerServicePurpose::GoalCustody
                && connection.same_runtime(runtime),
            "Goal custody caller refused",
        )?;
        GoalCustodyRequest::decode(connection.request_bytes())?;
        let identity = connection
            .held_identity()
            .map_err(|_| GoalCustodyError::Refused("Goal custody caller refused"))?;
        need(identity.can_progress(), "Goal custody caller refused")?;
        Ok(GoalCustodyAttempt {
            state: self.clone(),
            origin: runtime.installed_engine().clone(),
            identity,
            peer: *connection.peer(),
            files: PrivateBatch::new()?,
            pending: None,
            attempted: false,
            uncertain: false,
            closed: false,
        })
    }
    fn observe_identity(&self, fingerprint: &Fingerprint) -> Result<()> {
        let mut original = self
            .configuration_identity
            .lock()
            .map_err(|_| GoalCustodyError::Cleanup)?;
        if let Some(original) = original.as_ref() {
            need(
                original == fingerprint,
                "Private Goal configuration changed; restart required",
            )
        } else {
            *original = Some(fingerprint.clone());
            Ok(())
        }
    }
}
#[must_use = "retain the real private FDs, native call, accepted Record and uncertainty"]
pub struct GoalCustodyAttempt {
    state: Arc<GoalCustodyState>,
    origin: Arc<crate::installed_worker_engine::InstalledWorkerEngine>,
    identity: RelayIdentity,
    peer: WorkerPeer,
    files: PrivateBatch,
    pending: Option<CapturedCall>,
    attempted: bool,
    uncertain: bool,
    closed: bool,
}
impl GoalCustodyAttempt {
    fn assert_runtime(&self, runtime: &WorkerRuntime) -> Result<()> {
        need(
            Arc::ptr_eq(&self.origin, runtime.installed_engine()),
            "Goal custody runtime changed",
        )
    }
    pub fn project(
        &mut self,
        runtime: &WorkerRuntime,
        source: Option<&Path>,
        current: &EffectiveWorkerConfig,
    ) -> Result<Vec<u8>> {
        self.assert_runtime(runtime)?;
        need(
            !self.attempted && !self.closed,
            "Goal custody projection already attempted",
        )?;
        self.attempted = true;
        let source = source.ok_or(GoalCustodyError::Refused(
            "Private Goal bootstrap unavailable",
        ))?;
        let settings = GoalWorkerSettings::capture(current)?;
        let (configuration, digest) = self.configuration(source, &settings)?;
        configuration.require_owner_only()?;
        let observed = self.inventory(runtime, &configuration, &settings)?;
        self.check_projection_scope(source, &settings, &configuration, &observed)?;
        let identities = self.private_identities(&configuration)?;
        self.files.check()?;
        let (fresh, fresh_digest) = self.configuration(source, &settings)?;
        need(
            fresh.equivalent(&configuration) && fresh_digest == digest,
            "Private Goal configuration changed",
        )?;
        self.files.check()?;
        need(
            self.identity.can_progress() && !runtime.cancellation().is_cancelled(),
            "Goal custody caller refused",
        )?;
        Ok(reverie_contracts::goal_custody::encode_projection(
            &digest,
            &identities,
        ))
    }
    pub fn close(&mut self, runtime: &WorkerRuntime, end: Instant) -> Result<()> {
        self.assert_runtime(runtime)?;
        if self.closed {
            return Ok(());
        }
        // Keep an unsettled exact ticket. Opaque consumed-close failures
        // remain negative in the original captured owner on later checks.
        if let Some(call) = &self.pending
            && self.origin.engine.client.settle_call(call, end).is_ok()
        {
            self.pending = None;
        }
        if self.files.close().is_err() {
            self.uncertain = true;
        }
        if self.uncertain || self.pending.is_some() {
            return Err(GoalCustodyError::Cleanup);
        }
        self.closed = true;
        Ok(())
    }
}
impl Drop for GoalCustodyAttempt {
    fn drop(&mut self) {
        if !self.closed {
            // A native ticket and checked-close uncertainty are not erased by
            // ordinary destruction. The accepted handler keeps its real Hold.
            std::mem::forget(self.pending.take());
        }
    }
}
