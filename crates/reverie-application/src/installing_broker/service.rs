//! Actual one-shot service startup prefix. Native signals/check_pool precede
//! raw socket preparation, and real recovery precedes listener binding. This
//! owner is not yet a runnable all-verb broker or a readiness acknowledgement.
use super::*;
use reverie_host::{
    worker_reports::{
        BrokerListenerError, BrokerListenerFailure, PreparedBrokerListener, WorkerBrokerListener,
    },
    worker_runtime::{BrokerSignalFailure, BrokerSignals},
};
use std::{fmt, sync::atomic::Ordering, time::Instant};
mod installation_offer;
mod retained_pool;
mod running;
pub use retained_pool::BrokerPoolRestoreError;
use retained_pool::RetainedPoolStartup;
pub(super) use running::ClosedBrokerResources;
#[cfg(test)]
mod tests;
pub use running::{BrokerService, BrokerServiceClosed, BrokerServiceError, BrokerServiceFailure};
struct StartupOwner {
    broker: Arc<InstallingBroker>,
    signals: Option<BrokerSignals>,
    listener: Option<PreparedBrokerListener>,
    bound_listener: Option<WorkerBrokerListener>,
    installation_offer: Option<super::installation_offer::SharedInstallationOffer>,
}
enum StartupMode {
    Ordinary,
    Offer(Box<BrokerInstallationOffer>),
    RetainedPool(RetainedPoolStartup),
}
#[derive(Debug)]
pub enum BrokerStartupCause {
    AlreadyAttempted,
    InstallationOffer(Box<BrokerInstallationOfferCause>),
    Configuration(Box<GateError>),
    Signal(Box<BrokerSignalFailure>),
    Pool(Box<CreationBudgetError>),
    Listener(Box<BrokerListenerFailure>),
    Recovery(Box<RecoveryError>),
    PoolRestore(Box<BrokerPoolRestoreError>),
    RecoveryFinalization {
        primary: Box<Self>,
        cleanup: Box<GateError>,
    },
}
impl fmt::Display for BrokerStartupCause {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AlreadyAttempted => f.write_str("WORKER_BROKER_SERVICE_ALREADY_ATTEMPTED"),
            Self::InstallationOffer(error) => error.fmt(f),
            Self::Configuration(error) => error.fmt(f),
            Self::Signal(error) => error.fmt(f),
            Self::Pool(error) => error.fmt(f),
            Self::Listener(error) => error.fmt(f),
            Self::Recovery(error) => error.fmt(f),
            Self::PoolRestore(error) => error.fmt(f),
            Self::RecoveryFinalization { primary, cleanup } => {
                write!(
                    f,
                    "{primary} (recovery admission close failed with {cleanup})"
                )
            }
        }
    }
}
impl std::error::Error for BrokerStartupCause {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::AlreadyAttempted => None,
            Self::InstallationOffer(error) => Some(error.as_ref()),
            Self::Configuration(error) => Some(error.as_ref()),
            Self::Signal(error) => Some(error.as_ref()),
            Self::Pool(error) => Some(error.as_ref()),
            Self::Listener(error) => Some(error.as_ref()),
            Self::Recovery(error) => Some(error.as_ref()),
            Self::PoolRestore(error) => Some(error.as_ref()),
            Self::RecoveryFinalization { primary, .. } => Some(primary.as_ref()),
        }
    }
}
#[must_use = "retain complete startup ownership until actual service cleanup"]
pub struct BrokerServiceStartup {
    owner: StartupOwner,
    recovered: RecoverySummary,
}
#[must_use = "retain the same broker, partial listener/signals and startup cause"]
pub struct BrokerStartupFailure {
    owner: StartupOwner,
    cause: BrokerStartupCause,
}
impl fmt::Debug for BrokerStartupFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BrokerStartupFailure")
            .field("cause", &self.cause)
            .finish_non_exhaustive()
    }
}
impl fmt::Display for BrokerStartupFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.cause.fmt(f)
    }
}
impl std::error::Error for BrokerStartupFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.cause)
    }
}
impl InstallingBroker {
    /// Continue from genuine bootstrap, not from a request-selected runtime or
    /// a decoded readiness/authority value. The same actual broker is retained
    /// even when recovery has already published some real phones and leases.
    pub fn prepare_service(self) -> Result<BrokerServiceStartup, Box<BrokerStartupFailure>> {
        Arc::new(self).prepare_shared_service()
    }
    /// Preserve the SAME broker Arc retained by the supported outer bootstrap
    /// before recovery/listener effects. This is not a fresh service factory:
    /// a private irreversible latch permits one attempt across all Arc aliases.
    /// A refusal retains the same broker and no new signal/listener owner.
    pub fn prepare_shared_service(
        self: &Arc<Self>,
    ) -> Result<BrokerServiceStartup, Box<BrokerStartupFailure>> {
        self.prepare_owned_service(StartupMode::Ordinary)
    }
    fn prepare_owned_service(
        self: &Arc<Self>,
        mode: StartupMode,
    ) -> Result<BrokerServiceStartup, Box<BrokerStartupFailure>> {
        let (installation_offer, retained_pool) = match mode {
            StartupMode::Ordinary => (None, None),
            StartupMode::Offer(offer) => (
                Some(super::installation_offer::SharedInstallationOffer::retain(
                    *offer,
                )),
                None,
            ),
            StartupMode::RetainedPool(pool) => (None, Some(pool)),
        };
        let mut owner = StartupOwner {
            broker: Arc::clone(self),
            signals: None,
            listener: None,
            bound_listener: None,
            installation_offer,
        };
        if let Err(cause) = owner.assert_installation_offer_broker() {
            return Err(Box::new(BrokerStartupFailure { owner, cause }));
        }
        if self
            .service_start_claimed
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(Box::new(BrokerStartupFailure {
                owner,
                cause: BrokerStartupCause::AlreadyAttempted,
            }));
        }
        match owner.prepare(retained_pool) {
            Ok(recovered) => Ok(BrokerServiceStartup { owner, recovered }),
            Err(cause) => Err(Box::new(BrokerStartupFailure { owner, cause })),
        }
    }
}
impl StartupOwner {
    fn prepare(
        &mut self,
        retained_pool: Option<RetainedPoolStartup>,
    ) -> Result<RecoverySummary, BrokerStartupCause> {
        self.assert_installation_offer()?;
        let runtime = &self.broker.storage.runtime;
        self.signals = Some(
            runtime
                .install_broker_signals()
                .map_err(|error| BrokerStartupCause::Signal(Box::new(error)))?,
        );
        let snapshot = self
            .broker
            .configuration()
            .map_err(|error| BrokerStartupCause::Configuration(Box::new(error)))?;
        if let Some(pool) = retained_pool {
            return self.prepare_retained_pool(&snapshot, pool);
        }
        self.prepare_listener_for_recovery(&snapshot, None)?;
        let recovered = self
            .broker
            .recover_laptops()
            .map_err(|error| BrokerStartupCause::Recovery(Box::new(error)))?;
        self.assert_installation_offer()?;
        Ok(recovered)
    }

    fn prepare_listener_for_recovery(
        &mut self,
        snapshot: &ValidatedWorkerSnapshot,
        end: Option<Instant>,
    ) -> Result<(), BrokerStartupCause> {
        let configuration = snapshot.configuration();
        // Recovering existing laptops does not create tasks in the pool.
        // Ordinary startup and new launches retain the headroom check.
        let checked = match end {
            Some(end) => self.broker.check_pool_until(configuration, false, end),
            None => self.broker.check_pool(configuration, true),
        };
        checked.map_err(|error| BrokerStartupCause::Pool(Box::new(error)))?;
        super::recovered::check_deadline(end)
            .map_err(|error| BrokerStartupCause::Recovery(Box::new(error)))?;
        self.listener = Some(
            self.broker
                .storage
                .runtime
                .prepare_broker_listener(snapshot.envelope())
                .map_err(BrokerStartupCause::Listener)?,
        );
        Ok(())
    }
    fn close_listener_component(&mut self) -> Result<(), BrokerListenerError> {
        let prepared = self
            .listener
            .as_mut()
            .map_or(Ok(()), PreparedBrokerListener::close);
        let bound = self
            .bound_listener
            .as_mut()
            .map_or(Ok(()), WorkerBrokerListener::close);
        combine_listener_close(prepared, bound)
    }
}
impl BrokerServiceStartup {
    /// Reuse the actual startup's existing broker Arc, so a later consuming
    /// startup→running transition can move while this origin owner remains.
    /// Signals, listener, recovery and service readiness remain separate.
    pub fn retain_pool_controller_bootstrap(
        &self,
        end: Instant,
    ) -> Result<BrokerControllerBootstrap, Box<BrokerControllerBootstrapFailure>> {
        self.owner.broker.retain_pool_controller_bootstrap(end)
    }
    /// Separate explicit installation origin. The resulting nonclone owner
    /// must remain in the outer service/offer, outside InstallingBroker's Arc,
    /// so it cannot form a cycle with the broker it retains. No web consent or
    /// host administration grant is supplied by this observation.
    pub fn retain_pool_installation_offer_bootstrap(
        &self,
        end: Instant,
    ) -> Result<BrokerControllerBootstrap, Box<BrokerControllerBootstrapFailure>> {
        self.owner
            .broker
            .retain_pool_installation_offer_bootstrap(end)
    }
    /// Recovery inventory DATA, not proof that the supervisor/lease-peer and
    /// all protocol producers exist or that listening/readiness has started.
    pub fn recovered(&self) -> &RecoverySummary {
        &self.recovered
    }
    pub fn request_stop(&self) -> Instant {
        self.owner.broker.request_stop()
    }
    /// Listener component only. Existing/recovered App owners and installed
    /// signals remain held; no Runtime or service-wide ACK is returned.
    pub fn close_listener_component(&mut self) -> Result<(), BrokerListenerError> {
        self.owner.close_listener_component()
    }
}
impl BrokerStartupFailure {
    pub fn cause(&self) -> &BrokerStartupCause {
        &self.cause
    }
    pub fn request_stop(&self) -> Instant {
        self.owner.broker.request_stop()
    }
    /// Attempt both actual listener owners, including a failed native bind or
    /// stale-probe close. Do not seal the Runtime ahead of recovered resources.
    pub fn close_listener_component(&mut self) -> Result<(), BrokerListenerError> {
        let current = self.owner.close_listener_component();
        let failed = self.cause.close_failed_listener();
        combine_listener_close(current, failed)
    }
}

impl BrokerStartupCause {
    fn close_failed_listener(&mut self) -> Result<(), BrokerListenerError> {
        match self {
            Self::Listener(error) => error.close(),
            Self::RecoveryFinalization { primary, .. } => primary.close_failed_listener(),
            _ => Ok(()),
        }
    }
}

fn combine_listener_close(
    first: Result<(), BrokerListenerError>,
    second: Result<(), BrokerListenerError>,
) -> Result<(), BrokerListenerError> {
    match (first, second) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(error), Ok(())) | (Ok(()), Err(error)) => Err(error),
        (Err(primary), Err(secondary)) => Err(BrokerListenerError::Finalization {
            primary: Box::new(primary),
            secondary: Box::new(secondary),
        }),
    }
}
