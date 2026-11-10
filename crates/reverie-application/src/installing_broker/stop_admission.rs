//! Actual Broker.stop allocation admission, separate from launch and from the
//! Host owner which alone can perform its fixed stop/cleanup effects.
use super::*;
use crate::reservation_gate::OrdinaryStopAdmission;

#[must_use = "retain through actual stop body and checked admission finalization"]
pub(crate) struct WorkerStopAdmission<'a> {
    broker: &'a InstallingBroker,
    target: WorkerContainerName,
    gate: Option<OrdinaryStopAdmission>,
}
impl InstallingBroker {
    pub(in crate::installing_broker) fn bind_pool_original_cleanup(
        &self,
        fence: &mut crate::reservation_gate::PoolTransitionFence,
        channel: &reverie_host::worker_reports::WorkerActorChannel,
        drain: &reverie_host::worker_reports::WorkerOriginalHandlersDrain,
    ) -> Result<(), GateError> {
        let gate = self
            .resource_reservations()?
            .ok_or(GateError::Refused("POOL_TRANSITION_GATE_REQUIRED"))?;
        fence.assert_gate(gate)?;
        let binding = drain.cleanup_binding();
        binding.assert_owner(channel, &self.reports, &self.storage.runtime)?;
        fence.bind_original_cleanup(binding)
    }
    pub(in crate::installing_broker) fn admit_original_handler_cleanup(
        &self,
        connection: &reverie_host::worker_reports::WorkerLaunchConnection,
        target: &WorkerContainerName,
    ) -> Result<WorkerStopAdmission<'_>, GateError> {
        if !connection.same_runtime(&self.storage.runtime) {
            return Err(GateError::Refused("WORKER_STOP_ADMISSION_ORIGIN"));
        }
        let Some(gate) = self.resource_reservations()? else {
            return self.admit_ordinary_stop(target);
        };
        let gate = gate.admit_original_handler_cleanup(
            &self.installed,
            connection,
            target,
            &self.storage.runtime,
        )?;
        Ok(WorkerStopAdmission {
            broker: self,
            target: target.clone(),
            gate: Some(gate),
        })
    }
    pub(crate) fn admit_ordinary_stop(
        &self,
        target: &WorkerContainerName,
    ) -> Result<WorkerStopAdmission<'_>, GateError> {
        let gate = match self.resource_reservations()? {
            Some(gate) => Some(gate.admit_ordinary_stop(
                &self.installed,
                target,
                Some(&self.storage.runtime.stop_budget()),
            )?),
            None => {
                // A truly disabled installation has no allocation scope. An
                // inconsistent enabled snapshot cannot manufacture that branch.
                if reverie_contracts::worker_validation::WorkerValidationData::new(
                    self.configuration()?.configuration(),
                )
                .reservation()?
                .is_some()
                {
                    return Err(GateError::Refused(
                        "RESERVATION_INSTALL_REQUIRES_RECONCILIATION",
                    ));
                }
                None
            }
        };
        Ok(WorkerStopAdmission {
            broker: self,
            target: target.clone(),
            gate,
        })
    }
}
impl WorkerStopAdmission<'_> {
    pub(crate) fn assert_target(&self, target: &WorkerContainerName) -> Result<(), GateError> {
        if self.target != *target {
            return Err(GateError::Refused("WORKER_STOP_ADMISSION_TARGET"));
        }
        Ok(())
    }
    pub(crate) fn assert_broker(&self, broker: &InstallingBroker) -> Result<(), GateError> {
        if !std::ptr::eq(self.broker, broker) {
            return Err(GateError::Refused("WORKER_STOP_ADMISSION_ORIGIN"));
        }
        if let Some(gate) = &self.gate {
            gate.assert_origin(&broker.installed)?;
            gate.assert_runtime(&broker.storage.runtime)?;
        }
        Ok(())
    }
    pub(crate) fn close(self) -> Result<(), GateError> {
        match self.gate {
            Some(gate) => gate.close(),
            None => Ok(()),
        }
    }
    /// Body failure skips the success guard, but still checks all owned scope
    /// finalizers. Its real effect caller retains and combines the primary.
    pub(crate) fn abort(self) -> Result<(), GateError> {
        self.gate.map_or(Ok(()), OrdinaryStopAdmission::abort)
    }
}
