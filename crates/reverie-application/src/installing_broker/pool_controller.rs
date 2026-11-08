//! Original installed broker bootstrap only. This confers neither root owner
//! consent nor host registration, Fleet/Q maintenance or pool activation.
use super::*;
use reverie_host::worker_pool::{BrokerBootstrapBinding, BrokerBootstrapFailure};
use std::time::Instant;

#[must_use = "retain the original installing broker and bootstrap binding"]
pub struct BrokerControllerBootstrap {
    broker: Arc<InstallingBroker>,
    source: std::path::PathBuf,
    binding: BrokerBootstrapBinding,
    origin_closed: bool,
}
pub struct BrokerControllerBootstrapFailure {
    owner: Option<BrokerControllerBootstrap>,
    /// The same service is retained even when native capture returns its own
    /// partial owner before the complete App bootstrap can be assembled.
    unopened_broker: Option<Arc<InstallingBroker>>,
    cause: BrokerControllerBootstrapCause,
}
pub enum BrokerControllerBootstrapCause {
    Configuration(GateError),
    Native(Box<BrokerBootstrapFailure>),
    Observation(reverie_host::worker_pool::PoolError),
    Refused(&'static str),
}
impl BrokerControllerBootstrapFailure {
    pub fn cause(&self) -> &BrokerControllerBootstrapCause {
        &self.cause
    }
    pub fn close_origin_metadata(&mut self) -> Result<(), reverie_host::worker_pool::PoolError> {
        let result = match &mut self.cause {
            BrokerControllerBootstrapCause::Native(failure) => failure.close(),
            _ => self
                .owner
                .as_mut()
                .map_or(Ok(()), BrokerControllerBootstrap::close_origin_metadata),
        };
        if result.is_ok() {
            drop(self.unopened_broker.take());
        }
        result
    }
}
impl InstallingBroker {
    pub fn retain_pool_controller_bootstrap(
        self: &Arc<Self>,
        end: Instant,
    ) -> Result<BrokerControllerBootstrap, Box<BrokerControllerBootstrapFailure>> {
        let source = self
            .configuration()
            .map_err(|cause| {
                Box::new(BrokerControllerBootstrapFailure {
                    owner: None,
                    unopened_broker: None,
                    cause: BrokerControllerBootstrapCause::Configuration(cause),
                })
            })?
            .source_path()
            .map(std::path::Path::to_owned)
            .ok_or_else(|| {
                Box::new(BrokerControllerBootstrapFailure {
                    owner: None,
                    unopened_broker: None,
                    cause: BrokerControllerBootstrapCause::Refused(
                        "WORKER_POOL_BROKER_LOADER_SOURCE_REQUIRED",
                    ),
                })
            })?;
        let binding = self
            .storage
            .runtime
            .retain_pool_controller_bootstrap(end)
            .map_err(|cause| {
                Box::new(BrokerControllerBootstrapFailure {
                    owner: None,
                    unopened_broker: Some(Arc::clone(self)),
                    cause: BrokerControllerBootstrapCause::Native(cause),
                })
            })?;
        let mut owner = BrokerControllerBootstrap {
            broker: Arc::clone(self),
            source,
            binding,
            origin_closed: false,
        };
        match owner.assert_current(end) {
            Ok(()) => Ok(owner),
            Err(cause) => Err(Box::new(BrokerControllerBootstrapFailure {
                owner: Some(owner),
                unopened_broker: None,
                cause,
            })),
        }
    }
}
impl BrokerControllerBootstrap {
    pub fn assert_current(&mut self, end: Instant) -> Result<(), BrokerControllerBootstrapCause> {
        if self.origin_closed {
            return Err(BrokerControllerBootstrapCause::Refused(
                "WORKER_POOL_BROKER_BINDING_CLOSED",
            ));
        }
        let current = self
            .broker
            .configuration()
            .map_err(BrokerControllerBootstrapCause::Configuration)?;
        if current.source_path() != Some(self.source.as_path()) {
            return Err(BrokerControllerBootstrapCause::Refused(
                "WORKER_POOL_BROKER_LOADER_SOURCE_CHANGED",
            ));
        }
        self.binding
            .assert_registered_source(&self.broker.storage.runtime, &self.source, end)
            .map_err(BrokerControllerBootstrapCause::Observation)
    }
    pub fn birth_document_data(
        &mut self,
        policy: reverie_contracts::worker_pool::WorkerPoolPolicy,
        end: Instant,
    ) -> Result<reverie_contracts::worker_pool::ControllerBirthV2, BrokerControllerBootstrapCause>
    {
        self.assert_current(end)?;
        self.binding
            .birth_document_data(&self.broker.storage.runtime, policy, end)
            .map_err(BrokerControllerBootstrapCause::Observation)
    }
    pub fn close_origin_metadata(&mut self) -> Result<(), reverie_host::worker_pool::PoolError> {
        let result = self.binding.close();
        self.origin_closed |= result.is_ok();
        result
    }
}
impl Drop for BrokerControllerBootstrap {
    fn drop(&mut self) {
        if !self.origin_closed {
            // Default destruction never abandons the original service while
            // its native bootstrap descriptors lack checked finalization.
            std::mem::forget(Arc::clone(&self.broker));
        }
    }
}
impl Drop for BrokerControllerBootstrapFailure {
    fn drop(&mut self) {
        std::mem::forget(self.unopened_broker.take());
    }
}
