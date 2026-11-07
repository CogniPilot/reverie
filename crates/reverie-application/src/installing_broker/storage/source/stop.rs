//! Named source transitions; no resource reconstruction, callback or raw editor.
use super::*;
use reverie_contracts::{
    worker_config::{EffectiveWorkerConfig, WorkerPolicyDigest},
    worker_source_stop::SourceStopName,
};
impl RegisteredSource {
    fn registry(&self) -> Result<Arc<StorageRegistry>, StorageWorkflowError> {
        self.registry
            .upgrade()
            .ok_or_else(|| StorageWorkflowError::refused("RESOURCE_ORIGINAL_SOURCE_CHANGED"))
    }
    pub(crate) fn inspect_original_stop(
        &self,
        name: SourceStopName,
        current: &EffectiveWorkerConfig,
        end: Option<Instant>,
    ) -> Result<ProfileSessionId, StorageWorkflowError> {
        let registry = self.registry()?;
        let mut held =
            self.record.owner.lock().map_err(|_| {
                StorageWorkflowError::refused("RESOURCE_ORIGINAL_SOURCE_UNCONFIRMED")
            })?;
        if !matches!(held.as_ref(), Some(SourceOwned::Direct(_))) {
            return Err(StorageWorkflowError::refused(
                "RESOURCE_SOURCE_STOP_ALREADY_ATTEMPTED",
            ));
        }
        let Some(SourceOwned::Direct(owner)) = held.take() else {
            unreachable!("checked actual source")
        };
        let native = match registry
            .runtime
            .retain_original_source_stop(owner, name, current, end)
        {
            Ok(native) => native,
            Err(failure) => {
                let (owner, error) = failure.into_parts();
                *held = Some(SourceOwned::Direct(owner));
                return Err(error.into());
            }
        };
        *held = Some(SourceOwned::Stopping(Box::new(native)));
        let Some(SourceOwned::Stopping(native)) = held.as_mut() else {
            unreachable!("registered real Host owner")
        };
        native.inspect(&registry.runtime)?;
        Ok(native.policy_session().clone())
    }
    pub(crate) fn refuse_original_policy(&self) -> Result<(), StorageWorkflowError> {
        let registry = self.registry()?;
        let mut held =
            self.record.owner.lock().map_err(|_| {
                StorageWorkflowError::refused("RESOURCE_ORIGINAL_SOURCE_UNCONFIRMED")
            })?;
        let Some(SourceOwned::Stopping(native)) = held.as_mut() else {
            return Err(StorageWorkflowError::refused(
                "RESOURCE_SOURCE_STOP_OWNER_REQUIRED",
            ));
        };
        Ok(native.refuse_policy(&registry.runtime)?)
    }
    pub(crate) fn stop_original_after_policy(
        &self,
        policy: &WorkerPolicyDigest,
    ) -> Result<(), StorageWorkflowError> {
        let registry = self.registry()?;
        let mut held =
            self.record.owner.lock().map_err(|_| {
                StorageWorkflowError::refused("RESOURCE_ORIGINAL_SOURCE_UNCONFIRMED")
            })?;
        let Some(SourceOwned::Stopping(native)) = held.as_mut() else {
            return Err(StorageWorkflowError::refused(
                "RESOURCE_SOURCE_STOP_OWNER_REQUIRED",
            ));
        };
        Ok(native.stop_after_policy(&registry.runtime, policy)?)
    }
    pub(crate) fn release_original_resource(
        &self,
        end: Instant,
    ) -> Result<(), StorageWorkflowError> {
        let registry = self.registry()?;
        // The caller has freshly qualified this source as stopped. Its actual
        // phone must reject/join future request jobs BEFORE any lease FD close;
        // merely settling the shared engine would leave a constructor gap.
        self.record._office.close_for_stopped_source(end)?;
        let mut held =
            self.record.owner.lock().map_err(|_| {
                StorageWorkflowError::refused("RESOURCE_ORIGINAL_SOURCE_UNCONFIRMED")
            })?;
        match held.as_mut() {
            Some(SourceOwned::Stopping(native)) => {
                native.close_stopped_resource(&registry.runtime, end)?;
                *held = Some(SourceOwned::Closed);
                Ok(())
            }
            Some(SourceOwned::Direct(_)) => {
                // The private App caller has freshly qualified the already
                // stopped source. It closes the ORIGINAL acquired box.
                let Some(SourceOwned::Direct(owner)) = held.take() else {
                    unreachable!("checked actual source")
                };
                match owner.close(end) {
                    Ok(()) => {
                        *held = Some(SourceOwned::Closed);
                        Ok(())
                    }
                    Err(failure) => {
                        let (owner, cause) = failure.into_parts();
                        *held = Some(SourceOwned::Direct(Box::new(owner)));
                        Err(cause.into())
                    }
                }
            }
            _ => Err(StorageWorkflowError::refused(
                "RESOURCE_ORIGINAL_SOURCE_CONSUMED",
            )),
        }
    }
    pub(crate) fn finish_original_release(&self) -> Result<(), StorageWorkflowError> {
        let registry = self.registry()?;
        // Keep the established registry→record order and remove only after the
        // real final admission/native boundary and actual resource close.
        let mut entries = registry.lock(registry.runtime.stop_deadline())?;
        let at = entries.iter().position(|entry| Arc::ptr_eq(&entry.identity, &self.record.identity)
            && matches!(&entry.owner, EntryOwner::Source(record) if Arc::ptr_eq(record, &self.record)))
            .ok_or_else(|| StorageWorkflowError::refused("RESOURCE_ORIGINAL_SOURCE_CHANGED"))?;
        let held =
            self.record.owner.lock().map_err(|_| {
                StorageWorkflowError::refused("RESOURCE_ORIGINAL_SOURCE_UNCONFIRMED")
            })?;
        if !matches!(held.as_ref(), Some(SourceOwned::Closed)) {
            return Err(StorageWorkflowError::refused(
                "RESOURCE_ORIGINAL_SOURCE_RETAINED",
            ));
        }
        entries.remove(at);
        Ok(())
    }
}
impl StorageRegistry {
    pub(in crate::installing_broker) fn settle_original_sources(
        &self,
        end: Instant,
    ) -> Result<(), GateError> {
        let records = self
            .lock(Some(
                self.runtime
                    .stop_deadline()
                    .map_or(end, |stop| end.min(stop)),
            ))
            .map_err(|error| GateError::OriginalSource(Box::new(error)))?
            .iter()
            .filter_map(|entry| match &entry.owner {
                EntryOwner::Source(record) => Some(record.clone()),
                _ => None,
            })
            .collect::<Vec<_>>();
        let mut result = Ok(());
        for record in records {
            let next = record.settle_original_native(&self.runtime, end);
            result = crate::reservation_gate::finalized(result, next);
        }
        result
    }
}
impl SourceRecord {
    fn settle_original_native(
        &self,
        runtime: &WorkerRuntime,
        end: Instant,
    ) -> Result<(), GateError> {
        let Ok(mut held) = self.owner.try_lock() else {
            return Err(GateError::Refused("RESOURCE_ORIGINAL_SOURCE_RETAINED"));
        };
        let settled = match held.as_mut() {
            Some(SourceOwned::Stopping(native)) => native
                .settle_native(runtime, end)
                .map_err(|error| GateError::OriginalSource(Box::new(error.into()))),
            _ => Ok(()),
        };
        // Even a Closed local owner has not finished the actual final
        // admission boundary until its Source entry is gone.
        crate::reservation_gate::finalized(
            settled,
            Err(GateError::Refused("RESOURCE_ORIGINAL_SOURCE_RETAINED")),
        )
    }
}
