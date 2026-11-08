//! Original installed broker bootstrap only. This confers neither root owner
//! consent nor host registration, Fleet/Q maintenance or pool activation.
use super::*;
use reverie_host::worker_pool::{
    BrokerBootstrapBinding, BrokerBootstrapFailure, ControllerBirthPublication,
    PublishedControllerBirthData,
};
use std::time::Instant;

enum BootstrapKind {
    Service,
    InstallationOffer,
}
#[must_use = "retain the original installing broker and bootstrap binding"]
pub struct BrokerControllerBootstrap {
    broker: Arc<InstallingBroker>,
    source: std::path::PathBuf,
    binding: BrokerBootstrapBinding,
    origin_closed: bool,
    birth_attempted: bool,
    publication: Option<ControllerBirthPublication>,
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
        self.retain_pool_bootstrap(end, BootstrapKind::Service)
    }
    /// Origin for a future explicit OS-owner installation offer. The host
    /// observer requires that distinct versioned role in the original argv;
    /// an ordinary running broker cannot promote itself by calling this API.
    pub fn retain_pool_installation_offer_bootstrap(
        self: &Arc<Self>,
        end: Instant,
    ) -> Result<BrokerControllerBootstrap, Box<BrokerControllerBootstrapFailure>> {
        self.retain_pool_bootstrap(end, BootstrapKind::InstallationOffer)
    }
    fn retain_pool_bootstrap(
        self: &Arc<Self>,
        end: Instant,
        kind: BootstrapKind,
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
        let runtime = &self.storage.runtime;
        let binding = match kind {
            BootstrapKind::Service => runtime.retain_pool_controller_bootstrap(end),
            BootstrapKind::InstallationOffer => {
                runtime.retain_pool_installation_offer_bootstrap(&source, end)
            }
        }
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
            birth_attempted: false,
            publication: None,
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
        let publication = self
            .publication
            .as_mut()
            .map_or(Ok(()), ControllerBirthPublication::close);
        let binding = self.binding.close();
        let result = match (publication, binding) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(error), Ok(())) | (Ok(()), Err(error)) => Err(error),
            (Err(first), Err(second)) => Err(reverie_host::worker_pool::PoolError::Finalization(
                Box::new(first),
                Box::new(second),
            )),
        };
        self.origin_closed |= result.is_ok();
        result
    }
    /// Publish only the original bootstrap's immutable birth input beneath
    /// ~/reverie. The actual partial file owner is retained here before effects.
    /// This is not registration consent, policy activation or a kernel grant.
    pub fn publish_birth_metadata(
        &mut self,
        policy: reverie_contracts::worker_pool::WorkerPoolPolicy,
        end: Instant,
    ) -> Result<PublishedControllerBirthData, BrokerControllerBootstrapCause> {
        if self.birth_attempted {
            return Err(BrokerControllerBootstrapCause::Refused(
                "WORKER_POOL_PUBLICATION_REPLAYED",
            ));
        }
        self.birth_attempted = true;
        self.assert_current(end)?;
        self.publication = Some(
            self.binding
                .prepare_birth_publication(&self.broker.storage.runtime, &self.source, policy, end)
                .map_err(BrokerControllerBootstrapCause::Observation)?,
        );
        self.publication
            .as_mut()
            .expect("owner retained before publication")
            .publish()
            .map_err(BrokerControllerBootstrapCause::Observation)?;
        self.assert_current(end)?;
        self.publication
            .as_ref()
            .expect("same publication")
            .reference_data()
            .map_err(BrokerControllerBootstrapCause::Observation)
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
