//! SAME registry entry and Box across a native C stop; no new lease registry.
use super::*;
use reverie_contracts::worker_config::EffectiveWorkerConfig;
use reverie_host::{office::OfficePhone, worker_source_stop::ControlLaptopStop};
#[cfg(test)]
mod tests;

pub(in crate::installing_broker) struct ControlStorageStop {
    destination: ClaimDestination,
    native: Arc<Mutex<ControlLaptopStop>>,
    _phone: Option<OfficePhone>,
}
impl StorageClaim {
    pub(in crate::installing_broker) fn into_control_stop(
        self,
        source: &EffectiveWorkerConfig,
        end: Instant,
    ) -> Result<ControlStorageStop, Box<(Self, StorageWorkflowError)>> {
        match self.state {
            ClaimState::Legacy { registry, owner } => match registry
                .runtime
                .retain_control_laptop_stop(owner, source, end)
            {
                Ok(native) => Ok(ControlStorageStop {
                    destination: ClaimDestination::Legacy { registry },
                    native: Arc::new(Mutex::new(native)),
                    _phone: None,
                }),
                Err(failure) => {
                    let (owner, cause) = *failure;
                    Err(Box::new((
                        Self {
                            state: ClaimState::Legacy { registry, owner },
                        },
                        cause.into(),
                    )))
                }
            },
            ClaimState::Registered {
                registry,
                identity,
                paths,
                newly_claimed,
            } => {
                let result = registry.retain_control_stop(&identity, source, end);
                match result {
                    Ok(native) => Ok(ControlStorageStop {
                        destination: ClaimDestination::Registered {
                            registry,
                            identity,
                            newly_claimed,
                        },
                        native,
                        _phone: None,
                    }),
                    Err(cause) => Err(Box::new((
                        Self {
                            state: ClaimState::Registered {
                                registry,
                                identity,
                                paths,
                                newly_claimed,
                            },
                        },
                        cause,
                    ))),
                }
            }
            state @ ClaimState::Started(_) => Err(Box::new((
                Self { state },
                StorageWorkflowError::refused("WORKER_CONTROL_STOP_STARTED_PURPOSE"),
            ))),
        }
    }
}
impl StorageRegistry {
    fn retain_control_stop(
        &self,
        identity: &Arc<()>,
        source: &EffectiveWorkerConfig,
        end: Instant,
    ) -> Result<Arc<Mutex<ControlLaptopStop>>, StorageWorkflowError> {
        let mut entries = self.lock(self.runtime.stop_deadline())?;
        let index = selected(&entries, identity)?;
        if !entries[index].writer_checked || !matches!(entries[index].owner, EntryOwner::Direct(_))
        {
            return Err(refused());
        }
        self.retain_direct_control_stop(&mut entries, index, source, end)
    }
    fn retain_direct_control_stop(
        &self,
        entries: &mut Vec<Entry>,
        index: usize,
        source: &EffectiveWorkerConfig,
        end: Instant,
    ) -> Result<Arc<Mutex<ControlLaptopStop>>, StorageWorkflowError> {
        let mut entry = entries.remove(index);
        let EntryOwner::Direct(owner) = entry.owner else {
            unreachable!()
        };
        let result = self.runtime.retain_control_laptop_stop(owner, source, end);
        let (owner, result) = match result {
            Ok(owner) => {
                let native = Arc::new(Mutex::new(owner));
                (EntryOwner::ControlStop(native.clone()), Ok(native))
            }
            Err(failure) => {
                let (owner, cause) = *failure;
                (EntryOwner::Direct(owner), Err(cause.into()))
            }
        };
        entry.owner = owner;
        entries.insert(index, entry);
        result
    }
    pub(in crate::installing_broker) fn retain_started_control_stop(
        self: &Arc<Self>,
        started: &super::super::launch::StartedLaptop,
        source: &EffectiveWorkerConfig,
        end: Instant,
    ) -> Result<ControlStorageStop, StorageWorkflowError> {
        let paths = started.network.paths();
        let mut entries = self.lock(self.runtime.stop_deadline())?;
        let index = if paths.kind() == StorageKind::Employee {
            let index =
                started
                    .network
                    .started_registered_index(self, &entries, &started.created)?;
            if let EntryOwner::Direct(owner) = &entries[index].owner {
                let handoff = entries[index]
                    .started_handoff
                    .as_ref()
                    .ok_or_else(refused)?;
                handoff.assert_created(&self.runtime, &started.created)?;
                handoff.assert_storage(&self.runtime, owner)?;
                let native = self.retain_direct_control_stop(&mut entries, index, source, end)?;
                return Ok(ControlStorageStop {
                    destination: ClaimDestination::Registered {
                        registry: self.clone(),
                        identity: entries[index].identity.clone(),
                        newly_claimed: false,
                    },
                    native,
                    _phone: None,
                });
            }
            if !matches!(&entries[index].owner, EntryOwner::Laptop(workflow) if started.created.same_workflow(workflow))
            {
                return Err(refused());
            }
            Some(index)
        } else {
            None
        };
        let transferred =
            self.runtime
                .transfer_idle_laptop_control_stop(&started.created, source, end)?;
        let (native, phone) = transferred.into_parts();
        let native = Arc::new(Mutex::new(native));
        let destination = if let Some(index) = index {
            entries[index].owner = EntryOwner::ControlStop(native.clone());
            ClaimDestination::Registered {
                registry: self.clone(),
                identity: entries[index].identity.clone(),
                newly_claimed: false,
            }
        } else {
            ClaimDestination::Legacy {
                registry: self.clone(),
            }
        };
        Ok(ControlStorageStop {
            destination,
            native,
            _phone: Some(phone),
        })
    }
}
fn selected(entries: &[Entry], identity: &Arc<()>) -> Result<usize, StorageWorkflowError> {
    entries
        .iter()
        .position(|entry| Arc::ptr_eq(&entry.identity, identity))
        .ok_or_else(refused)
}
fn refused() -> StorageWorkflowError {
    StorageWorkflowError::refused("WORKER_CONTROL_STOP_STORAGE_CHANGED")
}
impl ControlStorageStop {
    pub(in crate::installing_broker) fn stop(&self) -> Result<(), StorageWorkflowError> {
        self.native
            .try_lock()
            .map_err(|_| refused())?
            .stop_after_admission(&self.destination.registry().runtime)
            .map_err(Into::into)
    }
    pub(in crate::installing_broker) fn settle(
        &self,
        end: Instant,
    ) -> Result<(), StorageWorkflowError> {
        self.native
            .try_lock()
            .map_err(|_| refused())?
            .settle_native(&self.destination.registry().runtime, end)
            .map_err(Into::into)
    }
    pub(in crate::installing_broker) fn reclaim(
        self,
        end: Instant,
    ) -> Result<StorageClaim, Box<(Self, StorageWorkflowError)>> {
        match self.reclaim_inner(end) {
            Ok(claim) => Ok(claim),
            Err(cause) => Err(Box::new((self, cause))),
        }
    }
    fn reclaim_inner(&self, end: Instant) -> Result<StorageClaim, StorageWorkflowError> {
        let registry = self.destination.registry();
        let mut entries = registry.lock(registry.runtime.stop_deadline())?;
        let index = match &self.destination {
            ClaimDestination::Registered { identity, .. } => {
                let index = selected(&entries, identity)?;
                if !matches!(&entries[index].owner, EntryOwner::ControlStop(native) if Arc::ptr_eq(native, &self.native))
                {
                    return Err(refused());
                }
                Some(index)
            }
            ClaimDestination::Legacy { .. } => None,
        };
        let mut native = self.native.try_lock().map_err(|_| refused())?;
        if let Some(phone) = &self._phone {
            phone.require_closed_for_resource(&registry.runtime, native.session())?;
        }
        let owner = native.take_stopped_storage(&registry.runtime, end)?;
        if let Some(index) = index {
            entries[index].owner = EntryOwner::Direct(owner);
            Ok(registry.handle(&entries[index], false))
        } else {
            Ok(StorageClaim {
                state: ClaimState::Legacy {
                    registry: registry.clone(),
                    owner,
                },
            })
        }
    }
}
