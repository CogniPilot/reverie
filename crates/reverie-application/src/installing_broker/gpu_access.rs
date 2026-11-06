use super::*;
use reverie_contracts::gpu_access::GpuCommand;
use reverie_core::gpu_access::GpuStatusData;
impl InstallingBroker {
    /// Typed internal C consumer. The actual transport must authenticate owner
    /// UID before dispatch; OfficeAPI never exposes these owner-local verbs.
    pub fn owner_gpu_control(&self, command: GpuCommand) -> Result<GpuStatusData, GateError> {
        self.gate
            .as_ref()
            .ok_or(GateError::Refused("GPU_OWNER_CONTROL_UNAVAILABLE"))?
            .gpu_command(command, &self.storage.runtime)
    }
    /// Canonical unprotected, non-attach J prefix only: AFTER image refresh and
    /// BEFORE ordinary admission/preparation. Ok is no laptop/start permission.
    pub fn gpu_cold_boundary(&self, session: &ProfileSessionId) -> Result<(), GateError> {
        let Some(gate) = &self.gate else {
            return Ok(());
        };
        gate.gpu_cold(session, &self.storage.runtime)
    }
}
impl InstalledWorker {
    pub(crate) fn publish_gpu(
        &self,
        proof: crate::reservation_gate::PublishedGpu,
        lifecycle: &LaptopLifecycle<'_>,
        context: &mut crate::reservation_observer::ObservationContext,
        slot: &RwLock<reverie_contracts::reservation_control::ControlBinding>,
    ) -> Result<(), GateError> {
        if !lifecycle.belongs_to(self) {
            return Err(GateError::Refused("GPU_LIFECYCLE_CHANGED"));
        }
        let (before, after, binding) = proof.into_parts();
        let mut current = self
            .current
            .write()
            .map_err(|_| GateError::Refused("WORKER_BROKER_CURRENT_UNAVAILABLE"))?;
        let mut bound = slot
            .write()
            .map_err(|_| GateError::Refused("RESERVATION_ADMISSION_UNAVAILABLE"))?;
        if !Arc::ptr_eq(&current.snapshot, &before)
            || before.source_path() != after.source_path()
            || !reverie_contracts::worker_config::equivalent(
                context.configuration(),
                before.configuration(),
            )
        {
            return Err(GateError::Refused("GPU_CONFIG_CHANGED"));
        }
        let next_context = context.with_applied_configuration(after.configuration().clone());
        let next = CurrentInstalled::capture(after);
        // Every fallible lock/check and complete tuple derivation has ended.
        // Gate state/context/current/binding stay held across all three writes.
        *context = next_context;
        *current = next;
        *bound = binding;
        Ok(())
    }
}
