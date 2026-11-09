//! Restore only the actual stopped Created record. App registry custody is
//! checked BEFORE Host extraction; publication after take is infallible.
use super::*;
use reverie_host::worker_laptop::{CreatedLaptop, CreatedStorageObservation, StoppedCreatedLaptop};

pub(in crate::installing_broker) struct CreatedStorageReturned {
    claim: StorageClaim,
    plan: ObservedCreatePlan,
    phone: OfficePhone,
    primary: Option<Arc<LaptopError>>,
    decision: FinalStorageDecision,
}
pub(in crate::installing_broker) struct CreatedStorageFinishFailure {
    returned: CreatedStorageReturned,
    cause: NetworkStorageError,
}
impl CreatedStorageFinishFailure {
    pub(in crate::installing_broker) fn cause(&self) -> &NetworkStorageError {
        &self.cause
    }
}
impl std::fmt::Debug for CreatedStorageFinishFailure {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.debug_struct("CreatedStorageFinishFailure")
            .field("session", self.returned.plan.session())
            .field("storage_kind", &self.returned.claim.paths().kind())
            .field("live_at_checked_return", &self.returned.decision.live)
            .field("original_native_error", &self.returned.primary)
            .field("cause", &self.cause)
            .finish_non_exhaustive()
    }
}
impl CreatedStorageReturned {
    pub(in crate::installing_broker) fn finish_storage(
        self,
        end: Instant,
    ) -> Result<(bool, Option<Arc<LaptopError>>), Box<CreatedStorageFinishFailure>> {
        let registry = match &self.claim.state {
            ClaimState::Started(_) => {
                return Err(Box::new(CreatedStorageFinishFailure {
                    returned: self,
                    cause: NetworkStorageError::Host(LaptopError::Refused(
                        "WORKER_CREATED_RETURN_ORIGIN",
                    )),
                }));
            }
            ClaimState::Registered { registry, .. } | ClaimState::Legacy { registry, .. } => {
                registry.clone()
            }
        };
        if let Err(cause) = self
            .phone
            .require_closed_for_resource(&registry.runtime, self.plan.session())
        {
            return Err(Box::new(CreatedStorageFinishFailure {
                returned: self,
                cause: NetworkStorageError::Host(LaptopError::Office(cause)),
            }));
        }
        let result = match &self.claim.state {
            ClaimState::Started(_) => unreachable!("same checked Created Box return"),
            ClaimState::Registered {
                registry, identity, ..
            } => super::super::super::finalization::finish_registered(
                registry,
                identity,
                &self.decision,
                end,
            )
            .map_err(NixStorageError::from)
            .map_err(NetworkStorageError::Nix),
            ClaimState::Legacy { .. } => {
                return match self.claim.release(end) {
                    Ok(()) => Ok((false, self.primary)),
                    Err(failure) => {
                        let (claim, cause) = failure.into_parts();
                        Err(Box::new(CreatedStorageFinishFailure {
                            returned: Self { claim, ..self },
                            cause: NetworkStorageError::Nix(NixStorageError::from(cause)),
                        }))
                    }
                };
            }
        };
        match result {
            Ok(retained) => Ok((retained, self.primary)),
            Err(cause) => Err(Box::new(CreatedStorageFinishFailure {
                returned: self,
                cause,
            })),
        }
    }
}

impl NetworkStoragePreparation {
    pub(in crate::installing_broker) fn observe_created_storage(
        &self,
        created: &CreatedLaptop,
    ) -> Result<CreatedStorageObservation, NetworkStorageError> {
        if !created.same_workflow(&self.workflow) {
            return Err(NetworkStorageError::Host(LaptopError::Refused(
                "WORKER_CREATED_ORIGIN",
            )));
        }
        let observation = self
            .destination
            .registry()
            .runtime
            .observe_created_final_storage(created)
            .map_err(NetworkStorageError::Host)?;
        if !observation.same_workflow(&self.workflow) {
            return Err(NetworkStorageError::Host(LaptopError::Refused(
                "WORKER_CREATED_STORAGE_ORIGIN",
            )));
        }
        Ok(observation)
    }
    pub(in crate::installing_broker) fn restore_stopped_created(
        &self,
        stopped: &StoppedCreatedLaptop,
        observation: &CreatedStorageObservation,
    ) -> Result<CreatedStorageReturned, NetworkStorageError> {
        if !observation.same_workflow(&self.workflow) {
            return Err(NetworkStorageError::Host(LaptopError::Refused(
                "WORKER_CREATED_STORAGE_ORIGIN",
            )));
        }
        match &self.destination {
            ReturnTo::Legacy { registry } => {
                let returned = registry
                    .runtime
                    .prepare_stopped_created_return(stopped, observation)
                    .map_err(NetworkStorageError::Host)?;
                let (owner, plan, _request, phone, cause) = returned.into_parts();
                Ok(CreatedStorageReturned {
                    claim: StorageClaim {
                        state: ClaimState::Legacy {
                            registry: registry.clone(),
                            owner,
                        },
                    },
                    plan,
                    phone,
                    primary: cause,
                    decision: FinalStorageDecision {
                        live: false,
                        brand: None,
                    },
                })
            }
            ReturnTo::Registered {
                registry,
                identity,
                newly_claimed,
            } => {
                let mut entries = registry
                    .lock(registry.runtime.stop_deadline())
                    .map_err(NixStorageError::from)
                    .map_err(NetworkStorageError::Nix)?;
                let index = selected(&entries, identity).map_err(NetworkStorageError::Nix)?;
                same_laptop(&entries[index], &self.workflow)?;
                let brand = Arc::new(());
                let returned = registry
                    .runtime
                    .prepare_stopped_created_return(stopped, observation)
                    .map_err(NetworkStorageError::Host)?;
                let (owner, plan, _request, phone, cause) = returned.into_parts();
                // Everything after extraction is infallible while this exact
                // registry guard excludes acquisition/replacement.
                entries[index].owner = EntryOwner::Finalizing(FinalizingStorage::Ready {
                    owner,
                    brand: brand.clone(),
                });
                let claim = registry.handle(&entries[index], *newly_claimed);
                Ok(CreatedStorageReturned {
                    claim,
                    plan,
                    phone,
                    primary: cause,
                    decision: FinalStorageDecision {
                        live: false,
                        brand: Some(brand),
                    },
                })
            }
        }
    }
}
