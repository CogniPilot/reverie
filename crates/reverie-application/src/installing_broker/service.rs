//! Actual one-shot service startup prefix. Native signals/check_pool precede
//! raw socket preparation, and real recovery precedes listener binding. This
//! owner is not yet a runnable all-verb broker or a readiness acknowledgement.
use super::*;
use reverie_host::{
    worker_reports::{BrokerListenerError, BrokerListenerFailure, PreparedBrokerListener},
    worker_runtime::{BrokerSignalFailure, BrokerSignals},
};
use std::{fmt, sync::atomic::Ordering, time::Instant};
mod running;
#[cfg(test)]
mod tests;
pub use running::{BrokerService, BrokerServiceClosed, BrokerServiceError, BrokerServiceFailure};
struct StartupOwner {
    broker: Arc<InstallingBroker>,
    signals: Option<BrokerSignals>,
    listener: Option<PreparedBrokerListener>,
}
#[derive(Debug)]
pub enum BrokerStartupCause {
    AlreadyAttempted,
    Configuration(Box<GateError>),
    Signal(Box<BrokerSignalFailure>),
    Pool(Box<CreationBudgetError>),
    Listener(Box<BrokerListenerFailure>),
    Recovery(Box<RecoveryError>),
}
impl fmt::Display for BrokerStartupCause {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AlreadyAttempted => f.write_str("WORKER_BROKER_SERVICE_ALREADY_ATTEMPTED"),
            Self::Configuration(error) => error.fmt(f),
            Self::Signal(error) => error.fmt(f),
            Self::Pool(error) => error.fmt(f),
            Self::Listener(error) => error.fmt(f),
            Self::Recovery(error) => error.fmt(f),
        }
    }
}
impl std::error::Error for BrokerStartupCause {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::AlreadyAttempted => None,
            Self::Configuration(error) => Some(error.as_ref()),
            Self::Signal(error) => Some(error.as_ref()),
            Self::Pool(error) => Some(error.as_ref()),
            Self::Listener(error) => Some(error.as_ref()),
            Self::Recovery(error) => Some(error.as_ref()),
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
        let mut owner = StartupOwner {
            broker: Arc::clone(self),
            signals: None,
            listener: None,
        };
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
        match owner.prepare() {
            Ok(recovered) => Ok(BrokerServiceStartup { owner, recovered }),
            Err(cause) => Err(Box::new(BrokerStartupFailure { owner, cause })),
        }
    }
}
impl StartupOwner {
    fn prepare(&mut self) -> Result<RecoverySummary, BrokerStartupCause> {
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
        self.broker
            .check_pool(snapshot.configuration(), true)
            .map_err(|error| BrokerStartupCause::Pool(Box::new(error)))?;
        self.listener = Some(
            runtime
                .prepare_broker_listener(snapshot.envelope())
                .map_err(BrokerStartupCause::Listener)?,
        );
        self.broker
            .recover_laptops()
            .map_err(|error| BrokerStartupCause::Recovery(Box::new(error)))
    }
    fn close_listener_component(&mut self) -> Result<(), BrokerListenerError> {
        self.listener
            .as_mut()
            .map_or(Ok(()), PreparedBrokerListener::close)
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
        let failed = match &mut self.cause {
            BrokerStartupCause::Listener(error) => error.close(),
            _ => Ok(()),
        };
        match (current, failed) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(error), Ok(())) | (Ok(()), Err(error)) => Err(error),
            (Err(primary), Err(secondary)) => Err(BrokerListenerError::Finalization {
                primary: Box::new(primary),
                secondary: Box::new(secondary),
            }),
        }
    }
}
