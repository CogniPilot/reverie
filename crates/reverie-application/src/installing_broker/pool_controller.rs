//! Original installed broker bootstrap only. This confers neither root owner
//! consent nor host registration, Fleet/Q maintenance or pool activation.
use super::*;
use reverie_host::worker_pool::{BrokerBootstrapBinding, BrokerBootstrapFailure};
use std::time::Instant;

#[must_use = "retain the original installing broker and bootstrap binding"]
pub struct BrokerControllerBootstrap<'broker> {
    broker: &'broker InstallingBroker,
    source: std::path::PathBuf,
    binding: BrokerBootstrapBinding,
}
pub struct BrokerControllerBootstrapFailure<'broker> {
    owner: Option<BrokerControllerBootstrap<'broker>>,
    cause: BrokerControllerBootstrapCause,
}
pub enum BrokerControllerBootstrapCause {
    Configuration(GateError),
    Native(Box<BrokerBootstrapFailure>),
    Observation(reverie_host::worker_pool::PoolError),
    Refused(&'static str),
}
impl BrokerControllerBootstrapFailure<'_> {
    pub fn cause(&self) -> &BrokerControllerBootstrapCause {
        &self.cause
    }
    pub fn close_origin_metadata(&mut self) -> Result<(), reverie_host::worker_pool::PoolError> {
        match &mut self.cause {
            BrokerControllerBootstrapCause::Native(failure) => failure.close(),
            _ => self
                .owner
                .as_mut()
                .map_or(Ok(()), |owner| owner.binding.close()),
        }
    }
}
impl InstallingBroker {
    pub fn retain_pool_controller_bootstrap(
        &self,
        end: Instant,
    ) -> Result<BrokerControllerBootstrap<'_>, Box<BrokerControllerBootstrapFailure<'_>>> {
        let source = self
            .configuration()
            .map_err(|cause| {
                Box::new(BrokerControllerBootstrapFailure {
                    owner: None,
                    cause: BrokerControllerBootstrapCause::Configuration(cause),
                })
            })?
            .source_path()
            .map(std::path::Path::to_owned)
            .ok_or_else(|| {
                Box::new(BrokerControllerBootstrapFailure {
                    owner: None,
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
                    cause: BrokerControllerBootstrapCause::Native(cause),
                })
            })?;
        let mut owner = BrokerControllerBootstrap {
            broker: self,
            source,
            binding,
        };
        match owner.assert_current(end) {
            Ok(()) => Ok(owner),
            Err(cause) => Err(Box::new(BrokerControllerBootstrapFailure {
                owner: Some(owner),
                cause,
            })),
        }
    }
}
impl BrokerControllerBootstrap<'_> {
    pub fn assert_current(&mut self, end: Instant) -> Result<(), BrokerControllerBootstrapCause> {
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
        self.binding.close()
    }
}
