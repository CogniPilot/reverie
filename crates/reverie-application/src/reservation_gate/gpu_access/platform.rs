use super::*;
use reverie_core::{
    decimal::UnsignedInteger,
    gpu_access::{GpuChoice, PhysicalGpu},
};
use reverie_host::gpu_access::{CdiObservation, GpuHardware, GpuHostError};
pub(super) trait Platform {
    fn catalogue(&self) -> std::result::Result<Vec<GpuChoice>, GpuHostError>;
    fn physical(&self, device: &GpuDeviceUuid) -> std::result::Result<PhysicalGpu, GpuHostError>;
    fn info(
        &self,
        end: Instant,
    ) -> std::result::Result<reverie_contracts::gpu_access::GpuEngineInformation, GpuHostError>;
    fn cdi(
        &self,
        info: &reverie_contracts::gpu_access::GpuEngineInformation,
        device: &GpuDeviceUuid,
        end: Instant,
    ) -> std::result::Result<CdiObservation, GpuHostError>;
    fn active(
        &self,
        pid: &UnsignedInteger,
        physical: &PhysicalGpu,
    ) -> std::result::Result<(), GpuHostError>;
    fn installed_consumers(
        &self,
        config: &EffectiveWorkerConfig,
    ) -> std::result::Result<bool, GpuHostError>;
}
pub(super) struct Installed {
    pub(super) engine: reverie_host::engine_metadata::ReadonlyEngine,
    pub(super) cancel: reverie_host::engine_metadata::CancellationToken,
}
impl Platform for Installed {
    fn catalogue(&self) -> std::result::Result<Vec<GpuChoice>, GpuHostError> {
        GpuHardware::catalogue()
    }
    fn physical(&self, device: &GpuDeviceUuid) -> std::result::Result<PhysicalGpu, GpuHostError> {
        GpuHardware::physical(device)
    }
    fn info(
        &self,
        end: Instant,
    ) -> std::result::Result<reverie_contracts::gpu_access::GpuEngineInformation, GpuHostError>
    {
        GpuHardware::engine_information(&self.engine, end, &self.cancel)
    }
    fn cdi(
        &self,
        info: &reverie_contracts::gpu_access::GpuEngineInformation,
        device: &GpuDeviceUuid,
        end: Instant,
    ) -> std::result::Result<CdiObservation, GpuHostError> {
        GpuHardware::cdi(info, device, end)
    }
    fn active(
        &self,
        pid: &UnsignedInteger,
        physical: &PhysicalGpu,
    ) -> std::result::Result<(), GpuHostError> {
        reverie_host::gpu_access::observe_active_device(pid, physical)
    }
    fn installed_consumers(
        &self,
        config: &EffectiveWorkerConfig,
    ) -> std::result::Result<bool, GpuHostError> {
        reverie_host::gpu_access::installed_consumers(config)
    }
}
