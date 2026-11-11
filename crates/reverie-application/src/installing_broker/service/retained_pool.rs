//! Restore a controller for the same installed pool before recovering laptops.
use super::*;
use crate::installing_broker::pool_controller::BrokerControllerActivationFailure;
use crate::reservation_gate::RecoveryAdmission;
use reverie_contracts::{
    worker_pool::{RetainedPoolAnchor, WorkerPoolProvider},
    worker_service::NativeWorkerServiceRole,
};
use std::time::Duration;

pub(super) struct RetainedPoolStartup {
    anchor: RetainedPoolAnchor,
    role: NativeWorkerServiceRole,
}

pub struct BrokerPoolRestoreError(PoolRestoreFailure);

enum PoolRestoreFailure {
    Bootstrap(Box<BrokerControllerBootstrapFailure>),
    Activation(Box<BrokerControllerActivationFailure>),
    Install(Box<ControllerInstallFailure>),
    Refused(&'static str),
}

impl BrokerPoolRestoreError {
    pub fn code(&self) -> &'static str {
        match &self.0 {
            PoolRestoreFailure::Bootstrap(error) => error.cause().code(),
            PoolRestoreFailure::Activation(error) => error.code(),
            PoolRestoreFailure::Install(error) => error.cause().code(),
            PoolRestoreFailure::Refused(code) => code,
        }
    }
}
impl fmt::Debug for BrokerPoolRestoreError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.debug_tuple("BrokerPoolRestoreError")
            .field(&self.code())
            .finish()
    }
}
impl fmt::Display for BrokerPoolRestoreError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for BrokerPoolRestoreError {}

fn restore_failure(failure: PoolRestoreFailure) -> BrokerStartupCause {
    BrokerStartupCause::PoolRestore(Box::new(BrokerPoolRestoreError(failure)))
}

impl InstallingBroker {
    /// Start with the installed provider and an exact, same-boot retained
    /// anchor. Host activation re-observes the anchor and authenticates the
    /// current process's original packaged role and registered source.
    pub fn prepare_service_with_retained_pool(
        self,
        anchor: RetainedPoolAnchor,
        role: NativeWorkerServiceRole,
    ) -> Result<BrokerServiceStartup, Box<BrokerStartupFailure>> {
        Arc::new(self).prepare_owned_service(StartupMode::RetainedPool(RetainedPoolStartup {
            anchor,
            role,
        }))
    }
}

impl StartupOwner {
    pub(super) fn prepare_retained_pool(
        &mut self,
        snapshot: &Arc<ValidatedWorkerSnapshot>,
        input: RetainedPoolStartup,
    ) -> Result<RecoverySummary, BrokerStartupCause> {
        let provider = WorkerPoolProvider::from_config(snapshot.configuration())
            .map_err(|_| {
                restore_failure(PoolRestoreFailure::Refused("WORKER_POOL_PROVIDER_INVALID"))
            })?
            .ok_or_else(|| {
                restore_failure(PoolRestoreFailure::Refused("WORKER_POOL_PROVIDER_REQUIRED"))
            })?;
        let broker = Arc::clone(&self.broker);
        let runtime = &broker.storage.runtime;
        let end = Instant::now() + Duration::from_secs(45);
        let end = runtime.stop_deadline().map_or(end, |stop| end.min(stop));
        let gate = broker
            .resource_reservations()
            .map_err(configuration)?
            .ok_or_else(|| {
                restore_failure(PoolRestoreFailure::Refused(
                    "WORKER_POOL_STARTUP_GATE_REQUIRED",
                ))
            })?;
        let admission = gate.admit_recovery_until(end).map_err(configuration)?;
        let recovered = self.restore_and_recover(snapshot, input, provider, &admission, end);
        conclude_recovery(admission, recovered)
    }

    fn restore_and_recover(
        &mut self,
        snapshot: &Arc<ValidatedWorkerSnapshot>,
        input: RetainedPoolStartup,
        provider: WorkerPoolProvider,
        admission: &RecoveryAdmission,
        end: Instant,
    ) -> Result<RecoverySummary, BrokerStartupCause> {
        admission
            .assert_pool_startup_current(snapshot)
            .map_err(configuration)?;
        let broker = Arc::clone(&self.broker);
        let mut lifecycle = broker
            .installed
            .recovery_lifecycle(end)
            .map_err(configuration)?;
        lifecycle.assert_recoverable().map_err(recovery_failure)?;
        let origin = match input.role {
            NativeWorkerServiceRole::Broker => self.broker.retain_pool_controller_bootstrap(end),
            NativeWorkerServiceRole::PoolOfferV1 => {
                self.broker.retain_pool_installation_offer_bootstrap(end)
            }
        }
        .map_err(|error| restore_failure(PoolRestoreFailure::Bootstrap(error)))?;
        let origin = origin
            .publish_restored_birth_metadata(input.anchor, snapshot, end)
            .map_err(|error| restore_failure(PoolRestoreFailure::Bootstrap(error)))?;
        let controller = origin
            .activate_controller(admission.host_reserve_mib(), end)
            .map_err(|error| restore_failure(PoolRestoreFailure::Activation(error)))?;
        self.broker
            .install_restored_controller(controller, &provider, end)
            .map_err(|error| restore_failure(PoolRestoreFailure::Install(error)))?;
        admission
            .assert_pool_startup_current(snapshot)
            .map_err(configuration)?;
        self.prepare_listener_for_recovery(snapshot, Some(end))?;
        broker
            .recover_running_locked(&mut lifecycle, Some(admission), Some(end))
            .map_err(recovery_failure)
    }
}

fn configuration(error: GateError) -> BrokerStartupCause {
    BrokerStartupCause::Configuration(Box::new(error))
}

fn recovery_failure(error: RecoveryError) -> BrokerStartupCause {
    BrokerStartupCause::Recovery(Box::new(error))
}

fn conclude_recovery(
    admission: RecoveryAdmission,
    recovered: Result<RecoverySummary, BrokerStartupCause>,
) -> Result<RecoverySummary, BrokerStartupCause> {
    match recovered {
        Ok(summary) => {
            admission.close().map_err(configuration)?;
            Ok(summary)
        }
        Err(primary) => match admission.abort() {
            Ok(()) => Err(primary),
            Err(cleanup) => Err(BrokerStartupCause::RecoveryFinalization {
                primary: Box::new(primary),
                cleanup: Box::new(cleanup),
            }),
        },
    }
}
