//! The SAME counted storage entry retains the real lease and native metadata
//! context. Neither stopped nor absent is physical release or capacity credit.
use super::*;
use crate::reservation_observer::{ObservationContext, StoppedRamObservation};
use reverie_contracts::worker_config::EffectiveWorkerConfig;
mod error;
mod record;
mod transition;
pub(crate) use error::{StoppedRamError, StoppedRamRestoreFailure, StoppedRamRetainFailure};
use error::{finalized, native, refused, storage};
pub(super) use record::Record;
use record::{Held, Outcome};
type StopResult<T> = std::result::Result<T, Arc<StoppedRamError>>;
#[must_use = "retain the whole source and actual claim on native uncertainty"]
pub(crate) struct StoppedRamSource {
    claim: Option<StorageClaim>,
    registry: Arc<StorageRegistry>,
    identity: Arc<()>,
    record: Arc<Mutex<Record>>,
    configuration: EffectiveWorkerConfig,
}
pub(crate) struct RestoredStoppedRamSource {
    claim: StorageClaim,
    primary: Option<Arc<StoppedRamError>>,
}
impl RestoredStoppedRamSource {
    pub(crate) fn into_parts(self) -> (StorageClaim, Option<Arc<StoppedRamError>>) {
        (self.claim, self.primary)
    }
}
impl StorageClaim {
    pub(crate) fn begin_stopped_ram_source(
        self,
        mut context: ObservationContext,
    ) -> std::result::Result<StoppedRamSource, Box<StoppedRamRetainFailure>> {
        match transition::fence(&self, &context) {
            Err(cause) => Err(Box::new(StoppedRamRetainFailure {
                claim: self,
                context,
                cause,
            })),
            Ok((registry, identity)) => {
                if let Err(cause) =
                    context.inherit_worker_stop_budget(&registry.runtime.stop_budget())
                {
                    return Err(Box::new(StoppedRamRetainFailure {
                        claim: self,
                        context,
                        cause: native(cause),
                    }));
                }
                let configuration = context.configuration().clone();
                let mut entries = match registry.lock(registry.runtime.stop_deadline()) {
                    Ok(entries) => entries,
                    Err(cause) => {
                        return Err(Box::new(StoppedRamRetainFailure {
                            claim: self,
                            context,
                            cause: storage(cause),
                        }));
                    }
                };
                let index = match transition::check_direct(
                    &entries,
                    &identity,
                    &self,
                    &context,
                    &registry.runtime,
                ) {
                    Ok(index) => index,
                    Err(cause) => {
                        drop(entries);
                        return Err(Box::new(StoppedRamRetainFailure {
                            claim: self,
                            context,
                            cause,
                        }));
                    }
                };
                let mut entry = entries.remove(index);
                let EntryOwner::Direct(owner) = entry.owner else {
                    unreachable!("same checked Direct Box")
                };
                let record = Arc::new(Mutex::new(Record {
                    held: Some(Held {
                        owner,
                        context,
                        outcome: Outcome::Fresh,
                    }),
                }));
                entry.owner = EntryOwner::StoppedRam(record.clone());
                entries.insert(index, entry);
                drop(entries);
                Ok(StoppedRamSource {
                    claim: Some(self),
                    registry,
                    identity,
                    record,
                    configuration,
                })
            }
        }
    }
}
impl StoppedRamSource {
    pub(crate) fn configuration(&self) -> &EffectiveWorkerConfig {
        &self.configuration
    }
    pub(crate) fn paths(&self) -> &StoragePaths {
        self.claim.as_ref().expect("same held claim").paths()
    }
    pub(crate) fn observe(&mut self) -> StopResult<Arc<StoppedRamObservation>> {
        self.assert_entry()?;
        self.record
            .try_lock()
            .map_err(|_| refused("RAM_STOPPED_SOURCE_IN_USE_OR_POISONED"))?
            .held()?
            .observe(&self.registry.runtime)
    }
    pub(crate) fn assert_current(&mut self) -> StopResult<()> {
        self.assert_entry()?;
        self.record
            .try_lock()
            .map_err(|_| refused("RAM_STOPPED_SOURCE_IN_USE_OR_POISONED"))?
            .held()?
            .recheck(&self.registry.runtime)
    }
    fn assert_entry(&self) -> StopResult<()> {
        let entries = self
            .registry
            .lock(self.registry.runtime.stop_deadline())
            .map_err(storage)?;
        transition::check_record(&entries, &self.identity, &self.record).map(|_| ())
    }
}
