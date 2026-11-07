//! Actual staged startup custody, before any installing broker is published.
#[cfg(test)]
mod tests;
use super::*;
use reverie_host::{
    command_telemetry::{CommandTelemetry, TelemetryError},
    worker_runtime::{RuntimeError, WorkerRuntime},
};
use std::{
    fmt,
    sync::{Mutex, OnceLock},
    time::Instant,
};
/// Primary startup cause is DATA; it does not replace the retained owner.
#[derive(Debug)]
pub enum BrokerBootstrapCause {
    Telemetry(Box<TelemetryError>),
    Gate(Box<GateError>),
}
impl BrokerBootstrapCause {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Telemetry(error) => error.code(),
            Self::Gate(error) => error.code(),
        }
    }
}
impl fmt::Display for BrokerBootstrapCause {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}
impl std::error::Error for BrokerBootstrapCause {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(match self {
            Self::Telemetry(error) => error.as_ref(),
            Self::Gate(error) => error.as_ref(),
        })
    }
}
struct BootstrapOwner {
    installed: Arc<InstalledWorker>,
    runtime: WorkerRuntime,
    telemetry: Option<Arc<CommandTelemetry>>,
    images: Option<Arc<chat_images::ChatImages>>,
}
/// Owns the SAME consumed Runtime, original installed snapshot and all complete
/// startup owners. No raw-runtime/authority extractor or replacement constructor.
#[must_use = "retain failed startup and check close before acknowledging settlement"]
pub struct BrokerBootstrapFailure {
    owner: Option<BootstrapOwner>,
    cause: BrokerBootstrapCause,
    settled: bool,
}
impl fmt::Debug for BrokerBootstrapFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BrokerBootstrapFailure")
            .field("code", &self.code())
            .finish_non_exhaustive()
    }
}
impl fmt::Display for BrokerBootstrapFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}
impl std::error::Error for BrokerBootstrapFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.cause)
    }
}
/// Both owner observations survive a failed checked close. Fields are private;
/// this error neither grants launch/release nor authorizes another constructor.
#[derive(Debug)]
pub struct BootstrapSettlementError {
    runtime: Option<Box<RuntimeError>>,
    telemetry_pending: bool,
}
impl BootstrapSettlementError {
    pub fn runtime_error(&self) -> Option<&RuntimeError> {
        self.runtime.as_deref()
    }
    pub fn telemetry_pending(&self) -> bool {
        self.telemetry_pending
    }
}
impl fmt::Display for BootstrapSettlementError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("WORKER_BOOTSTRAP_SETTLEMENT_UNCONFIRMED")
    }
}
impl std::error::Error for BootstrapSettlementError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.runtime.as_deref().map(|error| error as _)
    }
}
impl BrokerBootstrapFailure {
    pub fn code(&self) -> &'static str {
        self.cause.code()
    }
    pub fn cause(&self) -> &BrokerBootstrapCause {
        &self.cause
    }
    /// Borrowing retains every real owner on failure. First-stop is published
    /// before cleanup, never renewed; every actual engine constructor is settled
    /// even if telemetry is pending. Seal only after BOTH owners confirm clear.
    /// This is bootstrap-local settlement, not a laptop/global broker ACK.
    pub fn close(&mut self, deadline: Instant) -> Result<(), BootstrapSettlementError> {
        if self.settled {
            return Ok(());
        }
        let owner = self
            .owner
            .as_ref()
            .expect("failure retains its actual startup owner");
        let deadline = deadline.min(owner.runtime.request_stop());
        let runtime = owner.runtime.settle_owned(deadline).err().map(Box::new);
        let telemetry_pending = owner
            .telemetry
            .as_ref()
            .is_some_and(|owner| owner.has_pending_store());
        if runtime.is_some() || telemetry_pending {
            return Err(BootstrapSettlementError {
                runtime,
                telemetry_pending,
            });
        }
        let result = owner
            .runtime
            .close(deadline)
            .map_err(|error| BootstrapSettlementError {
                runtime: Some(Box::new(error)),
                telemetry_pending: false,
            });
        self.settled = result.is_ok();
        result
    }
}
impl Drop for BrokerBootstrapFailure {
    fn drop(&mut self) {
        if !self.settled
            && let Some(owner) = self.owner.take()
        {
            owner.runtime.request_stop();
            // An ignored error is never native settlement. Keep the SAME
            // runtime/snapshot/completed owners for process lifetime;
            // process exit is the outer boundary, not a release receipt.
            static ABANDONED: OnceLock<Mutex<Vec<BootstrapOwner>>> = OnceLock::new();
            ABANDONED
                .get_or_init(|| Mutex::new(Vec::new()))
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .push(owner);
        }
    }
}
impl BootstrapOwner {
    fn prepare(&mut self) -> Result<Option<ReservationGate>, BrokerBootstrapCause> {
        // Original WorkerChatImages is the inert manager allocation BEFORE
        // mandatory telemetry and configured Gate. No cache/thread is opened.
        self.images = Some(Arc::new(chat_images::ChatImages::new()));
        let current = self
            .installed
            .snapshot()
            .map_err(|error| BrokerBootstrapCause::Gate(Box::new(error)))?;
        self.telemetry = Some(Arc::new(
            CommandTelemetry::capture(&self.runtime, current.configuration())
                .map_err(|error| BrokerBootstrapCause::Telemetry(Box::new(error)))?,
        ));
        // Python constructor754: telemetry is complete BEFORE configured Gate
        // checks/marker reads. Office is constructed later in recovery/launch.
        gate(&self.installed, &self.runtime, &current)
            .map_err(|error| BrokerBootstrapCause::Gate(Box::new(error)))
    }
}
fn gate(
    installed: &Arc<InstalledWorker>,
    runtime: &WorkerRuntime,
    current: &ValidatedWorkerSnapshot,
) -> Result<Option<ReservationGate>, GateError> {
    let has_option =
        reverie_contracts::worker_validation::WorkerValidationData::new(current.configuration())
            .reservation()?
            .is_some();
    if has_option
        || reverie_host::reservation_control::prior_control_present(
            installed.resources()?.as_ref(),
        )?
    {
        Ok(Some(ReservationGate::from_installed(
            installed.clone(),
            NativeObserver::new(runtime.readonly()),
        )?))
    } else {
        Ok(None)
    }
}
impl InstallingBroker {
    pub(super) fn bootstrap(
        snapshot: ValidatedWorkerSnapshot,
        runtime: WorkerRuntime,
    ) -> Result<Self, Box<BrokerBootstrapFailure>> {
        let mut owner = BootstrapOwner {
            installed: InstalledWorker::capture(snapshot),
            runtime,
            telemetry: None,
            images: None,
        };
        let gate = match owner.prepare() {
            Ok(gate) => gate,
            Err(cause) => {
                return Err(Box::new(BrokerBootstrapFailure {
                    owner: Some(owner),
                    cause,
                    settled: false,
                }));
            }
        };
        let reports = Arc::new(
            reverie_host::worker_reports::WorkerReportService::from_runtime(&owner.runtime),
        );
        Ok(Self {
            installed: owner.installed,
            gate,
            storage: Arc::new(storage::StorageRegistry::new(owner.runtime)),
            telemetry: owner
                .telemetry
                .expect("successful actual telemetry constructor"),
            reports,
            recovery: Arc::new(RecoveryOwners::new()),
            goals: Arc::new(reverie_host::goal_custody::GoalCustodyState::new()),
            images: owner.images.expect("actual pre-telemetry image manager"),
        })
    }
}
