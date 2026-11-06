use super::*;
use reverie_contracts::kernel_mounts::MountTable;
use reverie_core::{decimal::UnsignedInteger, ids::ProfileSessionId};
use reverie_host::reservation_kernel::{CustodyPaths, ReservationKernel};
pub(super) trait Source: Send + Sync {
    fn query(
        &self,
        query: EngineQuery<'_>,
        end: Instant,
        cancellation: &CancellationToken,
    ) -> Result<String>;
    fn settle_owned(&self, end: Instant) -> Result<()>;
    fn host_root(&self, end: Instant) -> Result<HostAccounting>;
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
        Ok(self.kernel.host_root(end)?)
    }
    fn mount_table(&self, end: Instant) -> Result<MountTable> {
        Ok(self.kernel.mount_table(end)?)
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
