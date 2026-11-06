//! Fixed broker read-side observations. Captured facts confer no admission,
//! process effect, storage lease or journal completion authority.
mod capacity;
mod error;
mod source;
#[cfg(test)]
mod tests;
pub use capacity::{CapacityFacts, WebsiteBinding};
pub use error::ObserverError;
use error::{Result, need};
use reverie_contracts::{
    kernel_accounting::HostAccounting,
    reservation_engine::{
        ContainerRow, InventoryDecoder, InventoryRows, NativeLimitBinding, NativeStorageBinding,
        ObservedMemoryPolicy, ReservationConfiguration, StoppedState, inventory_ids,
    },
    worker_config::{EffectiveWorkerConfig, policy_digest},
};
use reverie_core::ids::ContainerId;
use reverie_host::engine_metadata::{CancellationToken, EngineQuery, ReadonlyEngine};
use reverie_store::storage_identity::StoragePaths;
use source::{Installed, Source};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

/// Keep one persistent engine context for the service lifetime. Failed queries
/// remain failures even after explicit owned-client cleanup completes.
pub struct NativeObserver {
    source: Box<dyn Source>,
    cancellation: CancellationToken,
}
impl NativeObserver {
    pub fn new(engine: ReadonlyEngine) -> Self {
        Self {
            source: Box::new(Installed::new(engine)),
            cancellation: CancellationToken::new(),
        }
    }
    pub fn cancellation(&self) -> CancellationToken {
        self.cancellation.clone()
    }
    pub fn settle_owned(&self, end: Instant) -> Result<()> {
        self.source.settle_owned(end)
    }
    /// The installing broker supplies captured configuration data. This does
    /// not validate the whole worker domain or accept a request-selected path.
    pub fn capture(
        &self,
        config: EffectiveWorkerConfig,
        inherited: Option<Instant>,
    ) -> ObservationContext<'_> {
        ObservationContext {
            observer: self,
            config: ReservationConfiguration::capture(config),
            inherited,
            origin: Arc::new(()),
        }
    }
}
pub struct ObservationContext<'a> {
    observer: &'a NativeObserver,
    config: ReservationConfiguration,
    inherited: Option<Instant>,
    origin: Arc<()>,
}
/// Only this context's actual engine census creates these handles. Public
/// contract rows remain data and cannot be supplied as native observations.
pub struct ObservedInventory {
    rows: InventoryRows,
    origin: Arc<()>,
}
pub struct ObservedRow<'a> {
    row: &'a ContainerRow,
    origin: &'a Arc<()>,
}
impl ObservedInventory {
    pub fn rows(&self) -> impl Iterator<Item = ObservedRow<'_>> {
        self.rows.rows().iter().map(|row| ObservedRow {
            row,
            origin: &self.origin,
        })
    }
}
impl ObservedRow<'_> {
    pub fn data(&self) -> &ContainerRow {
        self.row
    }
}
impl ObservationContext<'_> {
    fn check(&self, end: Instant) -> Result<()> {
        need(
            !self.observer.cancellation.is_cancelled(),
            "RESERVATION_OBSERVATION_CANCELLED",
        )?;
        need(Instant::now() < end, "RESERVATION_OBSERVATION_DEADLINE")
    }
    fn deadline(&self, supplied: Option<Instant>) -> Result<Instant> {
        let mut end = Instant::now() + Duration::from_secs(30);
        for bound in [self.inherited, supplied].into_iter().flatten() {
            end = end.min(bound);
        }
        self.check(end)?;
        Ok(end)
    }
    fn checked_row<'a>(&self, row: &'a ObservedRow<'_>) -> Result<&'a ContainerRow> {
        need(
            Arc::ptr_eq(&self.origin, row.origin),
            "RESERVATION_OBSERVATION_CONTEXT",
        )?;
        Ok(row.row)
    }
    fn engine(&self, query: EngineQuery<'_>, end: Instant) -> Result<String> {
        self.check(end)?;
        let result = self
            .observer
            .source
            .query(query, end, &self.observer.cancellation)?;
        self.check(end)?;
        Ok(result)
    }
    pub fn inventory(&self, supplied: Option<Instant>) -> Result<ObservedInventory> {
        self.inventory_at(self.deadline(supplied)?)
    }
    fn inventory_at(&self, end: Instant) -> Result<ObservedInventory> {
        let ids = inventory_ids(&self.engine(EngineQuery::InventoryIds, end)?)?;
        let mut decoder = InventoryDecoder::new(&ids)?;
        for batch in ids.chunks(32) {
            decoder.push(&self.engine(EngineQuery::InspectBatch(batch), end)?)?;
        }
        let rows = decoder.finish()?;
        self.check(end)?;
        Ok(ObservedInventory {
            rows,
            origin: self.origin.clone(),
        })
    }
    pub fn host_root(&self) -> Result<HostAccounting> {
        let end = self.deadline(None)?;
        let result = self.observer.source.host_root(end)?;
        self.check(end)?;
        Ok(result)
    }
    pub fn stopped_state(
        &self,
        row: &ObservedRow<'_>,
        supplied: Option<Instant>,
    ) -> Result<StoppedState> {
        let end = self.deadline(supplied)?;
        let row = self.checked_row(row)?;
        StoppedState::validate_ordinary(row)?;
        let output = self.engine(EngineQuery::InspectStopped(row.id()), end)?;
        let state = StoppedState::capture(row, &output)?;
        self.check(end)?;
        Ok(state)
    }
    pub fn custody(&self, supplied: Option<Instant>) -> Result<ObservedInventory> {
        let end = self.deadline(supplied)?;
        let source = &self.observer.source;
        let table = source.mount_table(end)?;
        let before = self.inventory_at(end)?;
        source.custody_scan(&self.config, &before.rows, &table, end)?;
        need(
            source.mount_table(end)? == table,
            "RESERVATION_MOUNT_TABLE_CHANGED",
        )?;
        let after = self.inventory_at(end)?;
        need(
            before.rows.mount_shape()? == after.rows.mount_shape()?,
            "RESERVATION_MOUNT_INVENTORY_CHANGED",
        )?;
        self.check(end)?;
        Ok(before)
    }
    pub fn limits(&self, row: &ObservedRow<'_>) -> Result<NativeLimitBinding> {
        self.limits_at(self.checked_row(row)?, self.deadline(None)?)
    }
    fn limits_at(&self, row: &ContainerRow, end: Instant) -> Result<NativeLimitBinding> {
        self.check(end)?;
        row.running_header()?;
        let policy = self.memory_policy(row)?;
        self.check(end)?;
        let result = self.observer.source.limits(row, policy.as_ref(), end)?;
        self.check(end)?;
        Ok(result)
    }
    fn memory_policy(&self, row: &ContainerRow) -> Result<Option<ObservedMemoryPolicy>> {
        if !self.config.memory_policies_enabled() {
            return Ok(None);
        }
        let Some(session) = row.memory_session(&self.config.deployment()?)? else {
            return Ok(None);
        };
        let effective = self
            .observer
            .source
            .effective_config(self.config.configuration().clone(), &session)?;
        let Some(policy) = ObservedMemoryPolicy::from_effective(&effective)? else {
            return Ok(None);
        };
        let repeated = self
            .observer
            .source
            .effective_config(self.config.configuration().clone(), &session)?;
        need(
            row.label_is("reverie.worker-policy", &policy_digest(&repeated).to_hex())?
                && row.memory_matches(policy.memory())?,
            "RESERVATION_SOURCE_POLICY",
        )?;
        Ok(Some(policy))
    }
    pub fn storage(
        &self,
        row: &ObservedRow<'_>,
        paths: &StoragePaths,
    ) -> Result<NativeStorageBinding> {
        let end = self.deadline(None)?;
        let row = self.checked_row(row)?;
        let result = self
            .observer
            .source
            .storage(&self.config, row, paths, end)?;
        self.check(end)?;
        Ok(result)
    }
    pub fn capacity(&self, inventory: &ObservedInventory) -> Result<CapacityFacts> {
        self.capacity_at(inventory, None)
    }
    pub fn capacity_stopped_website(
        &self,
        inventory: &ObservedInventory,
        id: &ContainerId,
    ) -> Result<CapacityFacts> {
        self.capacity_at(inventory, Some(id))
    }
}
