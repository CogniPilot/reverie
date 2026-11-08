use super::*;
use reverie_contracts::kernel_mounts::MountTable;
use reverie_core::{decimal::UnsignedInteger, ids::ProfileSessionId};
use reverie_host::reservation_kernel::{CustodyPaths, ReservationKernel};
pub(super) trait Source: Send + Sync {
    fn assert_worker_runtime(
        &self,
        runtime: &reverie_host::worker_runtime::WorkerRuntime,
    ) -> Result<()>;
    fn verify_launch_limits(
        &self,
        row: &reverie_contracts::broker_laptop::LaunchLaptopInspection,
        policy: Option<&ObservedMemoryPolicy>,
        end: Instant,
    ) -> Result<()>;
    fn verify_recovery_limits(
        &self,
        row: &reverie_contracts::worker_recovery::RecoveryInspection,
        policy: Option<&ObservedMemoryPolicy>,
        end: Instant,
    ) -> Result<()>;
    fn original_target_storage(
        &self,
        paths: &StoragePaths,
        baseline: &reverie_contracts::reservation_baseline::OriginalSourceBaseline,
        end: Instant,
    ) -> Result<()>;
    fn old_source_released(
        &self,
        row: &ContainerRow,
        baseline: &reverie_contracts::reservation_baseline::OriginalSourceBaseline,
        end: Instant,
    ) -> Result<()>;
    fn original_accounts_current(
        &self,
        runtime: &reverie_contracts::reservation_baseline::OriginalRuntimeTail,
        end: Instant,
    ) -> Result<()>;
    fn inspect_laptop(
        &self,
        name: &reverie_core::worker_laptop::WorkerContainerName,
        end: Instant,
        cancellation: &CancellationToken,
    ) -> Result<reverie_host::broker_engine::LaptopInspectOutput>;
    fn query(
        &self,
        query: EngineQuery<'_>,
        end: Instant,
        cancellation: &CancellationToken,
    ) -> Result<String>;
    fn settle_owned(&self, end: Instant) -> Result<()>;
    fn host_root(&self, end: Instant) -> Result<HostAccounting>;
    fn protected_pool(
        &self,
        _config: &ReservationConfiguration,
        _website: &NativeLimitBinding,
        _end: Instant,
    ) -> Result<()> {
        Err(ObserverError::Refused("RESERVATION_POOL_NATIVE_REQUIRED"))
    }
    fn pool_charge(
        &self,
        _config: &ReservationConfiguration,
        _website: &NativeLimitBinding,
        _row: &ContainerRow,
        _observed: &NativeLimitBinding,
        _policy: &ObservedMemoryPolicy,
        _end: Instant,
    ) -> Result<UnsignedInteger> {
        Err(ObserverError::Refused("RESERVATION_POOL_NATIVE_REQUIRED"))
    }
    fn mount_table(&self, end: Instant) -> Result<MountTable>;
    fn limits(
        &self,
        row: &ContainerRow,
        policy: Option<&ObservedMemoryPolicy>,
        end: Instant,
    ) -> Result<NativeLimitBinding>;
    fn custody_scan(
        &self,
        config: &ReservationConfiguration,
        paths: &CustodyPaths,
        rows: &InventoryRows,
        table: &MountTable,
        end: Instant,
    ) -> Result<()>;
    fn storage(
        &self,
        config: &ReservationConfiguration,
        row: &ContainerRow,
        paths: &StoragePaths,
        end: Instant,
    ) -> Result<NativeStorageBinding>;
    fn swap_total(&self, end: Instant) -> Result<UnsignedInteger>;
    fn original_runtime_tail(
        &self,
        row: &ContainerRow,
        limits: &NativeLimitBinding,
        end: Instant,
    ) -> Result<reverie_contracts::reservation_baseline::OriginalRuntimeTail>;
    fn effective_config(
        &self,
        config: EffectiveWorkerConfig,
        session: &ProfileSessionId,
    ) -> Result<EffectiveWorkerConfig>;
}
pub(super) struct Installed {
    engine: ReadonlyEngine,
    kernel: ReservationKernel,
}
impl Installed {
    pub(super) fn new(engine: ReadonlyEngine) -> Self {
        Self {
            engine,
            kernel: ReservationKernel::new(),
        }
    }
}
impl Source for Installed {
    fn assert_worker_runtime(
        &self,
        runtime: &reverie_host::worker_runtime::WorkerRuntime,
    ) -> Result<()> {
        Ok(self.engine.assert_worker_runtime(runtime)?)
    }
    fn verify_launch_limits(
        &self,
        row: &reverie_contracts::broker_laptop::LaunchLaptopInspection,
        policy: Option<&ObservedMemoryPolicy>,
        end: Instant,
    ) -> Result<()> {
        #[cfg(test)]
        tests::installed_read("launch_limits");
        Ok(self.kernel.verify_launch_limits(row, policy, end)?)
    }
    fn verify_recovery_limits(
        &self,
        row: &reverie_contracts::worker_recovery::RecoveryInspection,
        policy: Option<&ObservedMemoryPolicy>,
        end: Instant,
    ) -> Result<()> {
        #[cfg(test)]
        tests::installed_read("recovery_limits");
        Ok(self.kernel.verify_recovery_limits(row, policy, end)?)
    }
    fn original_target_storage(
        &self,
        paths: &StoragePaths,
        baseline: &reverie_contracts::reservation_baseline::OriginalSourceBaseline,
        end: Instant,
    ) -> Result<()> {
        Ok(self.kernel.original_target_storage(paths, baseline, end)?)
    }
    fn old_source_released(
        &self,
        row: &ContainerRow,
        baseline: &reverie_contracts::reservation_baseline::OriginalSourceBaseline,
        end: Instant,
    ) -> Result<()> {
        Ok(self.kernel.old_source_released(row, baseline, end)?)
    }
    fn original_accounts_current(
        &self,
        runtime: &reverie_contracts::reservation_baseline::OriginalRuntimeTail,
        end: Instant,
    ) -> Result<()> {
        Ok(self.kernel.original_accounts_current(runtime, end)?)
    }
    fn inspect_laptop(
        &self,
        name: &reverie_core::worker_laptop::WorkerContainerName,
        end: Instant,
        cancellation: &CancellationToken,
    ) -> Result<reverie_host::broker_engine::LaptopInspectOutput> {
        Ok(reverie_host::broker_engine::inspect_laptop(
            &self.engine,
            name,
            end,
            cancellation,
        )?)
    }
    fn query(
        &self,
        query: EngineQuery<'_>,
        end: Instant,
        cancellation: &CancellationToken,
    ) -> Result<String> {
        Ok(self.engine.query(query, end, cancellation)?)
    }
    fn settle_owned(&self, end: Instant) -> Result<()> {
        Ok(self.engine.settle_owned(end)?)
    }
    fn host_root(&self, end: Instant) -> Result<HostAccounting> {
        #[cfg(test)]
        tests::installed_read("host_root");
        Ok(self.kernel.host_root(end)?)
    }
    fn mount_table(&self, end: Instant) -> Result<MountTable> {
        Ok(self.kernel.mount_table(end)?)
    }
    fn protected_pool(
        &self,
        config: &ReservationConfiguration,
        website: &NativeLimitBinding,
        end: Instant,
    ) -> Result<()> {
        Ok(self
            .kernel
            .verify_protected_pool_memory(config, website, end)?)
    }
    fn pool_charge(
        &self,
        config: &ReservationConfiguration,
        website: &NativeLimitBinding,
        row: &ContainerRow,
        observed: &NativeLimitBinding,
        policy: &ObservedMemoryPolicy,
        end: Instant,
    ) -> Result<UnsignedInteger> {
        Ok(self
            .kernel
            .protected_pool_charge(config, website, row, observed, policy, end)?)
    }
    fn limits(
        &self,
        row: &ContainerRow,
        policy: Option<&ObservedMemoryPolicy>,
        end: Instant,
    ) -> Result<NativeLimitBinding> {
        Ok(self.kernel.limits(row, policy, end)?.into_binding())
    }
    fn custody_scan(
        &self,
        config: &ReservationConfiguration,
        paths: &CustodyPaths,
        rows: &InventoryRows,
        table: &MountTable,
        end: Instant,
    ) -> Result<()> {
        Ok(self.kernel.custody_paths(config, paths, rows, table, end)?)
    }
    fn storage(
        &self,
        config: &ReservationConfiguration,
        row: &ContainerRow,
        paths: &StoragePaths,
        end: Instant,
    ) -> Result<NativeStorageBinding> {
        Ok(self.kernel.storage(config, row, paths, end)?.into_binding())
    }
    fn swap_total(&self, end: Instant) -> Result<UnsignedInteger> {
        Ok(self.kernel.swap_total(end)?)
    }
    fn original_runtime_tail(
        &self,
        row: &ContainerRow,
        limits: &NativeLimitBinding,
        end: Instant,
    ) -> Result<reverie_contracts::reservation_baseline::OriginalRuntimeTail> {
        Ok(self.kernel.original_runtime_tail(row, limits, end)?)
    }
    fn effective_config(
        &self,
        config: EffectiveWorkerConfig,
        session: &ProfileSessionId,
    ) -> Result<EffectiveWorkerConfig> {
        Ok(crate::resource_staging::effective_config(config, session)?)
    }
}
