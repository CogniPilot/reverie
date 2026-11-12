//! Original installed broker bootstrap only. This confers neither root owner
//! consent nor host registration, Fleet/Q maintenance or pool activation.
use super::*;
use reverie_contracts::worker_pool::RetainedPoolAnchor;
use reverie_host::worker_pool::{
    BrokerBootstrapBinding, BrokerBootstrapFailure, ControllerBirthPublication,
    PublishedControllerBirthData,
};
use std::time::Instant;

enum BootstrapKind {
    Service,
    InstallationOffer,
}
pub(super) enum BrokerControllerActivationFailure {
    Bootstrap(Box<BrokerControllerBootstrapFailure>),
    Native(Box<reverie_host::worker_pool::ControllerActivationFailure>),
}
impl BrokerControllerActivationFailure {
    pub(super) fn code(&self) -> &'static str {
        match self {
            Self::Bootstrap(error) => error.cause().code(),
            Self::Native(error) => error.primary_error().code(),
        }
    }
    pub(super) fn close_components(
        &mut self,
        end: Instant,
    ) -> Result<(), reverie_host::worker_pool::PoolError> {
        match self {
            Self::Bootstrap(owner) => owner.close_origin_metadata(),
            Self::Native(owner) => owner.close_components(end),
        }
    }
}
#[must_use = "retain the original installing broker and bootstrap binding"]
pub struct BrokerControllerBootstrap {
    broker: Arc<InstallingBroker>,
    source: std::path::PathBuf,
    binding: Option<BrokerBootstrapBinding>,
    origin_transferred: bool,
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
impl BrokerControllerBootstrapCause {
    pub(super) fn code(&self) -> &'static str {
        match self {
            Self::Configuration(error) => error.code(),
            Self::Native(error) => error.primary_error().code(),
            Self::Observation(error) => error.code(),
            Self::Refused(code) => code,
        }
    }
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
            binding: Some(binding),
            origin_transferred: false,
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
    pub(super) fn publish_restored_birth_metadata(
        mut self,
        anchor: RetainedPoolAnchor,
        original: &ValidatedWorkerSnapshot,
        end: Instant,
    ) -> Result<Self, Box<BrokerControllerBootstrapFailure>> {
        let expected = reverie_contracts::worker_config::config_digest(original.configuration());
        match self.publish_birth(
            |binding, runtime, source| {
                binding.prepare_restored_birth_publication(
                    runtime,
                    source,
                    &expected,
                    Some(anchor),
                    end,
                )
            },
            end,
        ) {
            Ok(_) => Ok(self),
            Err(cause) => Err(Box::new(BrokerControllerBootstrapFailure {
                owner: Some(self),
                unopened_broker: None,
                cause,
            })),
        }
    }

    pub(super) fn activate_controller(
        mut self,
        host_reserve_mib: u32,
        end: Instant,
    ) -> Result<
        reverie_host::worker_pool::ActivatedController,
        Box<BrokerControllerActivationFailure>,
    > {
        let checked = self.assert_current(end).and_then(|()| {
            if self.binding.is_some() && self.publication.is_some() {
                Ok(())
            } else {
                Err(BrokerControllerBootstrapCause::Refused(
                    "WORKER_POOL_ACTIVATION_SOURCE_REQUIRED",
                ))
            }
        });
        if let Err(cause) = checked {
            return Err(Box::new(BrokerControllerActivationFailure::Bootstrap(
                Box::new(BrokerControllerBootstrapFailure {
                    owner: Some(self),
                    unopened_broker: None,
                    cause,
                }),
            )));
        }
        let binding = self
            .binding
            .take()
            .expect("original native binding checked");
        let publication = self
            .publication
            .take()
            .expect("original publication checked");
        // Actual custody transfer of BOTH native owners. Publication metadata
        // is not relabeled as closed, and no App Arc enters the installed slot.
        self.origin_transferred = true;
        binding
            .activate_controller(
                publication,
                &self.broker.storage.runtime,
                host_reserve_mib,
                end,
            )
            .map_err(|owner| Box::new(BrokerControllerActivationFailure::Native(owner)))
    }
    pub(super) fn published_birth_reference(
        &self,
    ) -> Result<PublishedControllerBirthData, BrokerControllerBootstrapCause> {
        self.publication
            .as_ref()
            .ok_or(BrokerControllerBootstrapCause::Refused(
                "WORKER_POOL_BIRTH_NOT_PUBLISHED",
            ))?
            .reference_data()
            .map_err(BrokerControllerBootstrapCause::Observation)
    }
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
            .as_mut()
            .ok_or(BrokerControllerBootstrapCause::Refused(
                "WORKER_POOL_BINDING_TRANSFERRED",
            ))?
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
            .as_mut()
            .ok_or(BrokerControllerBootstrapCause::Refused(
                "WORKER_POOL_BINDING_TRANSFERRED",
            ))?
            .birth_document_data(&self.broker.storage.runtime, policy, end)
            .map_err(BrokerControllerBootstrapCause::Observation)
    }
    pub fn close_origin_metadata(&mut self) -> Result<(), reverie_host::worker_pool::PoolError> {
        let publication = self
            .publication
            .as_mut()
            .map_or(Ok(()), ControllerBirthPublication::close);
        let binding = self
            .binding
            .as_mut()
            .map_or(Ok(()), BrokerBootstrapBinding::close);
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
        self.publish_birth(
            |binding, runtime, source| {
                binding.prepare_birth_publication(runtime, source, policy, end)
            },
            end,
        )
    }
    fn publish_birth(
        &mut self,
        prepare: impl FnOnce(
            &mut BrokerBootstrapBinding,
            &reverie_host::worker_runtime::WorkerRuntime,
            &std::path::Path,
        )
            -> Result<ControllerBirthPublication, reverie_host::worker_pool::PoolError>,
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
            prepare(
                self.binding
                    .as_mut()
                    .ok_or(BrokerControllerBootstrapCause::Refused(
                        "WORKER_POOL_BINDING_TRANSFERRED",
                    ))?,
                &self.broker.storage.runtime,
                &self.source,
            )
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
        if !self.origin_closed && !self.origin_transferred {
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
