//! Fixed broker read-side observations. Captured facts confer no admission,
//! process effect, storage lease or journal completion authority.
mod capacity;
mod custody;
mod error;
mod shared_pool;
mod source;
mod stop_budget;
mod stopped_ram;
pub(crate) use stopped_ram::{StoppedRamObservation, StoppedRamPresence};
#[cfg(test)]
pub(crate) mod tests;
pub use capacity::{CapacityFacts, WebsiteBinding};
pub use error::ObserverError;
use error::{Result, need};
use reverie_contracts::{
    kernel_accounting::HostAccounting,
    reservation_engine::{
        ContainerRow, InventoryDecoder, InventoryRows, NativeLimitBinding, NativeLimitFields,
        NativeStorageBinding, ObservedMemoryPolicy, ReservationConfiguration, StoppedState,
        inventory_ids,
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
#[derive(Clone)]
pub struct NativeObserver {
    source: Arc<dyn Source>,
    cancellation: CancellationToken,
    controller: Option<crate::installing_broker::InstalledControllerSlot>,
}
impl NativeObserver {
    /// Actual worker memory reads share its existing capture, cancellation and
    /// first-stop ceiling. No caller token/deadline selector or new runner.
    pub(crate) fn capture_worker(
        runtime: &reverie_host::worker_runtime::WorkerRuntime,
        config: EffectiveWorkerConfig,
    ) -> ObservationContext {
        let observer = Self {
            source: Arc::new(Installed::new(runtime.readonly())),
            cancellation: runtime.cancellation(),
            controller: None,
        };
        observer.capture(config, runtime.stop_deadline())
    }
    pub fn new(engine: ReadonlyEngine) -> Self {
        Self {
            source: Arc::new(Installed::new(engine)),
            cancellation: CancellationToken::new(),
            controller: None,
        }
    }
    pub(crate) fn with_installed_controller(
        engine: ReadonlyEngine,
        controller: crate::installing_broker::InstalledControllerSlot,
    ) -> Self {
        let mut observer = Self::new(engine);
        observer.controller = Some(controller);
        observer
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
    ) -> ObservationContext {
        ObservationContext {
            metadata: self.source.capture_metadata_owner().map(Arc::new),
            observer: self.clone(),
            config: ReservationConfiguration::capture(config),
            inherited,
            origin: Arc::new(()),
            stop_budget: None,
        }
    }
}
pub struct ObservationContext {
    metadata: Option<Arc<reverie_host::engine_metadata::MetadataQueryOwner>>,
    observer: NativeObserver,
    config: ReservationConfiguration,
    inherited: Option<Instant>,
    origin: Arc<()>,
    stop_budget: Option<reverie_host::worker_runtime::WorkerStopBudget>,
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
    pub(crate) fn gpu_selected(
        &self,
        config: &EffectiveWorkerConfig,
        current: &reverie_contracts::storage_identity::CurrentEmployee,
    ) -> std::result::Result<Option<ObservedRow<'_>>, reverie_contracts::gpu_access::GpuDataError>
    {
        self.employee_selected(config, current)
    }
    /// Reuse the same exact current EID/SID/name/label selection and native
    /// context origin. This grants no GPU, resource mutation or release.
    pub(crate) fn employee_selected(
        &self,
        config: &EffectiveWorkerConfig,
        current: &reverie_contracts::storage_identity::CurrentEmployee,
    ) -> std::result::Result<Option<ObservedRow<'_>>, reverie_contracts::gpu_access::GpuDataError>
    {
        let selected =
            reverie_contracts::gpu_access::selected_container(&self.rows, config, current)?;
        Ok(selected
            .and_then(|id| self.rows.rows().iter().find(|row| row.id() == &id))
            .map(|row| ObservedRow {
                row,
                origin: &self.origin,
            }))
    }
    /// Python structural equality of census DATA, independent of the sealed
    /// per-context row origin. This never makes another context's rows usable.
    pub fn equivalent(&self, other: &Self) -> bool {
        self.rows.equivalent(&other.rows)
    }
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
impl ObservationContext {
    /// Borrow the SAME original context's readonly native calls and custody.
    /// Callers must join the actual runtime/engine; this creates no new owner.
    pub(crate) fn metadata_query_owner(
        &self,
    ) -> Result<&reverie_host::engine_metadata::MetadataQueryOwner> {
        self.metadata.as_deref().ok_or(ObserverError::Refused(
            "RESERVATION_NATIVE_METADATA_OWNER_REQUIRED",
        ))
    }
    pub(crate) fn assert_inventory_origin(&self, rows: &ObservedInventory) -> Result<()> {
        need(
            Arc::ptr_eq(&self.origin, &rows.origin),
            "RESERVATION_OBSERVATION_CONTEXT",
        )
    }
    pub(crate) fn provider_process(
        &self,
        observer: &mut reverie_host::website_facts::WebsiteProcessObserver,
        row: &ObservedRow<'_>,
        end: Instant,
    ) -> std::result::Result<
        reverie_host::website_facts::ProviderProcessObservation,
        reverie_host::website_facts::WebsiteFactsError,
    > {
        let convert =
            |e: ObserverError| reverie_host::website_facts::WebsiteFactsError::Refused(e.code());
        let end = self.deadline(Some(end)).map_err(convert)?;
        let result = self.observer.source.provider_process(
            self.metadata.as_deref(),
            observer,
            self.checked_row(row).map_err(convert)?,
            end,
            &self.observer.cancellation,
        )?;
        self.check(end).map_err(convert)?;
        Ok(result)
    }
    /// Exact calls owned by THIS observation context only. Whole Runtime
    /// shutdown retains its separate global settlement operation.
    pub(crate) fn settle_metadata_owned(&self, end: Instant) -> Result<()> {
        let end = self.live_stop_deadline().map_or(end, |stop| stop.min(end));
        self.observer
            .source
            .settle_metadata_owner(self.metadata.as_deref(), end)
    }
    pub(crate) fn original_target_storage(
        &self,
        paths: &StoragePaths,
        baseline: &reverie_contracts::reservation_baseline::OriginalSourceBaseline,
    ) -> Result<()> {
        let end = self.deadline(None)?;
        self.observer
            .source
            .original_target_storage(paths, baseline, end)?;
        self.check(end)
    }
    pub(crate) fn old_source_released(
        &self,
        row: &ObservedRow<'_>,
        baseline: &reverie_contracts::reservation_baseline::OriginalSourceBaseline,
    ) -> Result<()> {
        let end = self.deadline(None)?;
        let row = self.checked_row(row)?;
        self.observer
            .source
            .old_source_released(row, baseline, end)?;
        self.check(end)
    }
    pub(crate) fn original_accounts_current(
        &self,
        runtime: &reverie_contracts::reservation_baseline::OriginalRuntimeTail,
    ) -> Result<()> {
        let end = self.deadline(None)?;
        self.observer
            .source
            .original_accounts_current(runtime, end)?;
        self.check(end)
    }
    #[cfg(test)]
    pub(crate) fn same_source_for_test(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.origin, &other.origin)
            && Arc::ptr_eq(&self.observer.source, &other.observer.source)
    }
    pub(crate) fn configuration(&self) -> &EffectiveWorkerConfig {
        self.config.configuration()
    }
    /// Only the installing broker's completed real reload uses this transition.
    /// Captured source, deadline and row origin remain exactly the same.
    pub(crate) fn with_applied_configuration(&self, config: EffectiveWorkerConfig) -> Self {
        Self {
            observer: self.observer.clone(),
            metadata: self.metadata.clone(),
            config: ReservationConfiguration::capture(config),
            inherited: self.inherited,
            origin: self.origin.clone(),
            stop_budget: self.stop_budget.clone(),
        }
    }
    pub(crate) fn inspect_laptop(
        &self,
        name: &reverie_core::worker_laptop::WorkerContainerName,
        supplied: Option<Instant>,
    ) -> Result<reverie_host::broker_engine::LaptopInspectOutput> {
        let end = self.deadline(supplied)?;
        let output = self.observer.source.inspect_laptop(
            self.metadata.as_deref(),
            name,
            end,
            &self.observer.cancellation,
        )?;
        self.check(end)?;
        Ok(output)
    }
    /// Internal operation bound update only: preserve the same captured worker
    /// data, persistent source and opaque census origin across admission phases.
    pub(crate) fn with_inherited(&self, inherited: Option<Instant>) -> Self {
        Self {
            observer: self.observer.clone(),
            metadata: self.metadata.clone(),
            config: ReservationConfiguration::capture(self.config.configuration().clone()),
            inherited,
            origin: self.origin.clone(),
            stop_budget: self.stop_budget.clone(),
        }
    }
    fn check(&self, end: Instant) -> Result<()> {
        need(
            !self.observer.cancellation.is_cancelled(),
            "RESERVATION_OBSERVATION_CANCELLED",
        )?;
        let end = self.live_stop_deadline().map_or(end, |stop| stop.min(end));
        need(Instant::now() < end, "RESERVATION_OBSERVATION_DEADLINE")
    }
    pub(crate) fn deadline(&self, supplied: Option<Instant>) -> Result<Instant> {
        let mut end = Instant::now() + Duration::from_secs(30);
        for bound in [self.inherited, supplied, self.live_stop_deadline()]
            .into_iter()
            .flatten()
        {
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
        let result = self.observer.source.query(
            self.metadata.as_deref(),
            query,
            end,
            &self.observer.cancellation,
        )?;
        self.check(end)?;
        Ok(result)
    }
    /// Full image metadata through THIS context's same native engine/query
    /// ticket. Exact image IDs are DATA, never a load/create command.
    pub(crate) fn worker_image_metadata(
        &self,
        image: &reverie_contracts::worker_image_switch::WorkerImageId,
        end: Instant,
    ) -> Result<String> {
        self.engine(
            EngineQuery::WorkerImageInspect(image),
            self.deadline(Some(end))?,
        )
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
        self.custody_selected(custody::SelectedTargets::Control, supplied)
    }
    pub fn limits(&self, row: &ObservedRow<'_>) -> Result<NativeLimitBinding> {
        self.limits_at(self.checked_row(row)?, self.deadline(None)?)
    }
    fn limits_at(&self, row: &ContainerRow, end: Instant) -> Result<NativeLimitBinding> {
        self.check(end)?;
        row.running_header()?;
        let policy = self.memory_policy_fields(&row.fields_for_limits())?;
        self.check(end)?;
        let result = self.observer.source.limits(row, policy.as_ref(), end)?;
        self.check(end)?;
        Ok(result)
    }
    pub(crate) fn verify_recovery_limits(
        &self,
        row: &reverie_contracts::worker_recovery::RecoveryInspection,
    ) -> Result<()> {
        let end = self.deadline(None)?;
        let fields = row.fields_for_limits()?;
        fields.running_header()?;
        let policy = self.memory_policy_fields(&fields)?;
        self.check(end)?;
        self.observer
            .source
            .verify_recovery_limits(row, policy.as_ref(), end)?;
        self.check(end)
    }
    pub(crate) fn verify_launch_limits(
        &self,
        row: &reverie_contracts::broker_laptop::LaunchLaptopInspection,
    ) -> Result<()> {
        let end = self.deadline(None)?;
        let fields = row.fields_for_limits()?;
        fields.running_header()?;
        let policy = self.memory_policy_fields(&fields)?;
        self.check(end)?;
        self.observer
            .source
            .verify_launch_limits(row, policy.as_ref(), end)?;
        self.check(end)
    }
    fn memory_policy_fields(
        &self,
        row: &NativeLimitFields<'_>,
    ) -> Result<Option<ObservedMemoryPolicy>> {
        self.memory_policy_fields_at(row, false)
    }
    fn memory_policy_fields_at(
        &self,
        row: &NativeLimitFields<'_>,
        stable_pool_policy: bool,
    ) -> Result<Option<ObservedMemoryPolicy>> {
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
                && row.memory_matches(policy.memory())?
                && (!stable_pool_policy || policy_digest(&effective) == policy_digest(&repeated)),
            "RESERVATION_SOURCE_POLICY",
        )?;
        self.running_memory_policy(row, policy).map(Some)
    }
    fn running_memory_policy(
        &self,
        row: &NativeLimitFields<'_>,
        policy: ObservedMemoryPolicy,
    ) -> Result<ObservedMemoryPolicy> {
        if !policy.uses_pool() {
            return Ok(policy);
        }
        let Some(provider) = reverie_contracts::worker_pool::WorkerPoolProvider::from_config(
            self.config.configuration(),
        )
        .map_err(|_| ObserverError::Refused("RESERVATION_POOL_PROVIDER_INVALID"))?
        else {
            return Ok(policy);
        };
        for (employee, settings) in provider.member_overrides() {
            if row.label_is("reverie.employee", employee)? {
                return Ok(policy.with_pool_member_policy(*settings)?);
            }
        }
        Ok(policy)
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
    pub(crate) fn original_runtime_tail(
        &self,
        row: &ObservedRow<'_>,
        limits: &NativeLimitBinding,
    ) -> Result<reverie_contracts::reservation_baseline::OriginalRuntimeTail> {
        let end = self.deadline(None)?;
        let row = self.checked_row(row)?;
        need(
            row.id() == limits.container_id() && row.pid()? == limits.pid()?,
            "RESOURCE_NATIVE_SOURCE_CHANGED",
        )?;
        let result = self
            .observer
            .source
            .original_runtime_tail(row, limits, end)?;
        self.check(end)?;
        Ok(result)
    }
    pub fn capacity(&self, inventory: &ObservedInventory) -> Result<CapacityFacts> {
        self.capacity_at(inventory, None, false)
    }
    pub(crate) fn pool_creation_capacity(
        &self,
        inventory: &ObservedInventory,
    ) -> Result<CapacityFacts> {
        self.capacity_at(inventory, None, true)
    }
    pub fn capacity_stopped_website(
        &self,
        inventory: &ObservedInventory,
        id: &ContainerId,
    ) -> Result<CapacityFacts> {
        self.capacity_at(inventory, Some(id), false)
    }
}
