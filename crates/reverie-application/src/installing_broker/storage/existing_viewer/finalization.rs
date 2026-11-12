//! Actual handler-finalization purposes over the SAME retained resource.
use super::*;
use crate::installing_broker::WorkerStopAdmission;
use reverie_host::worker_laptop::ExistingStorageObservation;

impl ExistingStoragePreparation {
    pub(in crate::installing_broker) fn completed(&self) -> Result<bool, ExistingStorageError> {
        self.check()?;
        let observed = self
            .destination
            .registry()
            .runtime
            .observe_existing_viewer_receipt(&self.viewer)?;
        if !observed.same_owner(&self.viewer) {
            return Err(ExistingStorageError::Refused(
                "WORKER_RECEIPT_OWNER_CHANGED",
            ));
        }
        Ok(observed.is_file())
    }
    pub(in crate::installing_broker) fn stop_under_admission(
        &self,
        broker: &InstallingBroker,
        admission: WorkerStopAdmission<'_>,
    ) -> Result<(), ExistingStorageError> {
        let body = (|| {
            self.check()?;
            if !Arc::ptr_eq(self.destination.registry(), &broker.storage) {
                return Err(ExistingStorageError::Refused("WORKER_STOP_STORAGE_ORIGIN"));
            }
            admission
                .assert_broker(broker)
                .map_err(StorageWorkflowError::from)?;
            let runtime = &self.destination.registry().runtime;
            let target = runtime.existing_viewer_stop_target(&self.viewer)?;
            admission
                .assert_target(&target)
                .map_err(StorageWorkflowError::from)?;
            Ok(runtime.stop_existing_viewer_laptop_for_worker(&self.viewer)?)
        })();
        let closed = if body.is_ok() {
            admission.close()
        } else {
            admission.abort()
        };
        match (body, closed) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(primary), Ok(())) => Err(primary),
            (Ok(()), Err(error)) => Err(StorageWorkflowError::from(error).into()),
            (Err(primary), Err(secondary)) => Err(ExistingStorageError::Finalized {
                primary: Box::new(primary),
                secondary: Box::new(StorageWorkflowError::from(secondary).into()),
            }),
        }
    }
    pub(in crate::installing_broker) fn observe_final_storage(
        &self,
    ) -> Result<ExistingStorageObservation, ExistingStorageError> {
        self.check()?;
        Ok(self
            .destination
            .registry()
            .runtime
            .observe_existing_final_storage(&self.viewer)?)
    }
    pub(in crate::installing_broker) fn target(
        &self,
    ) -> Result<WorkerContainerName, ExistingStorageError> {
        self.check()?;
        Ok(self
            .destination
            .registry()
            .runtime
            .existing_viewer_stop_target(&self.viewer)?)
    }
    pub(in crate::installing_broker) fn reclaim_final_storage(
        mut self,
        observation: &ExistingStorageObservation,
    ) -> Result<ExistingStorageReturned, Box<ExistingStorageReclaimFailure>> {
        let result = match &self.destination {
            Destination::Legacy { registry } => {
                reclaim_legacy(registry, &self.viewer, Some(observation))
            }
            Destination::Registered {
                registry,
                identity,
                newly_claimed,
            } => reclaim_registered(
                registry,
                identity,
                &self.viewer,
                *newly_claimed,
                Some(observation),
            ),
        };
        match result {
            Ok(mut returned) => {
                returned.predecessor_office = self.predecessor_office.take();
                Ok(returned)
            }
            Err(error) => Err(Box::new(ExistingStorageReclaimFailure {
                preparation: self,
                error,
            })),
        }
    }
}
pub(in crate::installing_broker) struct ExistingStorageFinishFailure {
    pub(in crate::installing_broker::storage) returned: ExistingStorageReturned,
    pub(in crate::installing_broker::storage) cause: ExistingStorageError,
}
impl ExistingStorageFinishFailure {
    pub(in crate::installing_broker) fn into_parts(
        self,
    ) -> (ExistingStorageReturned, ExistingStorageError) {
        (self.returned, self.cause)
    }
}
impl ExistingStorageReturned {
    pub(in crate::installing_broker) fn finish_storage(
        mut self,
        end: Instant,
    ) -> Result<bool, Box<ExistingStorageFinishFailure>> {
        let Some(decision) = &self.finalization else {
            return Err(Box::new(ExistingStorageFinishFailure {
                returned: self,
                cause: ExistingStorageError::Refused("WORKER_FINAL_STORAGE_PHASE"),
            }));
        };
        if !decision.live
            && let Some(phone) = &self.predecessor_office
        {
            let registry = match &self.claim.state {
                ClaimState::Legacy { registry, .. } | ClaimState::Registered { registry, .. } => {
                    registry
                }
                ClaimState::Started(_) => {
                    unreachable!("actual Existing return owns its original Box")
                }
            };
            if let Err(cause) =
                phone.require_closed_for_resource(&registry.runtime, self.claim.paths().session())
            {
                return Err(Box::new(ExistingStorageFinishFailure {
                    returned: self,
                    cause: StorageWorkflowError::from(cause).into(),
                }));
            }
        }
        if let ClaimState::Registered {
            registry, identity, ..
        } = &self.claim.state
        {
            let result =
                super::super::finalization::finish_registered(registry, identity, decision, end);
            return result.map_err(|cause| {
                Box::new(ExistingStorageFinishFailure {
                    returned: self,
                    cause: cause.into(),
                })
            });
        }
        let Self {
            claim,
            inputs,
            outcome,
            finalization,
            predecessor_office,
        } = self;
        match claim.release(end) {
            Ok(()) => Ok(false),
            Err(failure) => {
                let (claim, error) = failure.into_parts();
                self = Self {
                    claim,
                    inputs,
                    outcome,
                    finalization,
                    predecessor_office,
                };
                Err(Box::new(ExistingStorageFinishFailure {
                    returned: self,
                    cause: error.into(),
                }))
            }
        }
    }
}
