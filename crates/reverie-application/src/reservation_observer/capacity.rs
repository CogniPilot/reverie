use super::*;
use reverie_contracts::reservation_engine::StoppedWebsite;
use reverie_core::{
    capacity::{self, CapacityCounter},
    decimal::UnsignedInteger,
};
pub enum WebsiteBinding {
    Running(NativeLimitBinding),
    Stopped(StoppedWebsite),
}
impl WebsiteBinding {
    pub fn memory(&self) -> &UnsignedInteger {
        match self {
            Self::Running(value) => value.memory(),
            Self::Stopped(value) => value.memory(),
        }
    }
}
pub struct CapacityFacts {
    total: UnsignedInteger,
    budget: UnsignedInteger,
    website: WebsiteBinding,
    commitments: Vec<NativeLimitBinding>,
}
impl CapacityFacts {
    pub fn total(&self) -> &UnsignedInteger {
        &self.total
    }
    pub fn budget(&self) -> &UnsignedInteger {
        &self.budget
    }
    pub fn website(&self) -> &WebsiteBinding {
        &self.website
    }
    pub fn commitments(&self) -> &[NativeLimitBinding] {
        &self.commitments
    }
}
impl ObservationContext {
    pub(super) fn capacity_at(
        &self,
        inventory: &ObservedInventory,
        stopped: Option<&ContainerId>,
        pool_creation: bool,
    ) -> Result<CapacityFacts> {
        let end = self.deadline(None)?;
        need(
            Arc::ptr_eq(&self.origin, &inventory.origin),
            "RESERVATION_OBSERVATION_CONTEXT",
        )?;
        let host = self.observer.source.host_root(end)?;
        let site_name = format!("/{}", self.config.server_container()?);
        let sites = inventory
            .rows
            .rows()
            .iter()
            .filter(|row| row.name_is(&site_name))
            .collect::<Vec<_>>();
        need(sites.len() == 1, "RESERVATION_WEBSITE_BINDING")?;
        let website = match stopped {
            None => WebsiteBinding::Running(self.limits_at(sites[0], end)?),
            Some(id) => WebsiteBinding::Stopped(sites[0].stopped_website(id)?),
        };
        let mut slot = self
            .observer
            .controller
            .as_ref()
            .map(|slot| {
                slot.try_lock()
                    .map_err(|_| ObserverError::Refused("RESERVATION_POOL_CONTROLLER_UNAVAILABLE"))
            })
            .transpose()?;
        let mut shared = self.shared_capacity(slot.as_deref_mut(), &website, end)?;
        if pool_creation && shared.is_none() {
            let WebsiteBinding::Running(binding) = &website else {
                return Err(ObserverError::Refused("RESERVATION_POOL_WEBSITE_REQUIRED"));
            };
            self.observer
                .source
                .protected_pool(&self.config, binding, end)?;
        }
        let (total, commitments) =
            self.capacity_commitments(inventory, &website, pool_creation, &mut shared, end)?;
        if self.config.memory_policies_enabled() {
            self.swap_budget(&inventory.rows, end)?;
        }
        let budget = self.config.pool_bytes()?;
        let host_pool = budget.plus(&UnsignedInteger::from_u64(shared.as_ref().map_or(
            0,
            reverie_host::worker_pool::ControllerCapacity::outside_controller_memory_bytes,
        )));
        need(
            capacity::explicit_host_headroom_fits(
                counter(&host_pool)?,
                counter(website.memory())?,
                counter(&self.config.reserve_bytes()?)?,
                counter(host.total())?,
                counter(host.available())?,
            )?,
            "RESERVATION_HOST_BUDGET",
        )?;
        let zero = CapacityCounter::try_new(0)?;
        need(
            capacity::pool_headroom_fits(counter(&budget)?, counter(&total)?, zero, zero)?,
            "RESERVATION_CAPACITY_EXHAUSTED",
        )?;
        if pool_creation && shared.is_none() {
            let WebsiteBinding::Running(binding) = &website else {
                return Err(ObserverError::Refused("RESERVATION_POOL_WEBSITE_REQUIRED"));
            };
            self.observer
                .source
                .protected_pool(&self.config, binding, end)?;
        }
        if let Some(shared) = shared.as_mut() {
            shared
                .assert_current()
                .map_err(|error| ObserverError::Refused(error.code()))?;
        }
        self.check(end)?;
        Ok(CapacityFacts {
            total,
            budget,
            website,
            commitments,
        })
    }
    fn capacity_commitments(
        &self,
        inventory: &ObservedInventory,
        website: &WebsiteBinding,
        pool_creation: bool,
        shared: &mut Option<reverie_host::worker_pool::ControllerCapacity<'_>>,
        end: Instant,
    ) -> Result<(UnsignedInteger, Vec<NativeLimitBinding>)> {
        let mut total = UnsignedInteger::from_u64(shared.as_ref().map_or(
            0,
            reverie_host::worker_pool::ControllerCapacity::parent_memory_bytes,
        ));
        let mut commitments = Vec::new();
        for row in inventory.rows.rows() {
            self.check(end)?;
            let worker = row.worker()?;
            let running = row.running()?;
            if worker {
                let pid = row
                    .pid()
                    .map_err(|_| ObserverError::Refused("RESERVATION_NATIVE_STATE"))?;
                need(pid.is_zero() != running, "RESERVATION_NATIVE_STATE")?;
            }
            if worker && running {
                let (binding, legacy_charge) =
                    self.capacity_member(row, website, pool_creation && shared.is_none(), end)?;
                let charge = match shared.as_mut() {
                    Some(shared) => shared
                        .incremental_memory(row, &binding)
                        .map_err(|error| ObserverError::Refused(error.code()))?,
                    None => legacy_charge,
                };
                total = total.plus(&charge);
                commitments.push(binding);
            }
        }
        Ok((total, commitments))
    }
    fn capacity_member(
        &self,
        row: &ContainerRow,
        website: &WebsiteBinding,
        pool_creation: bool,
        end: Instant,
    ) -> Result<(NativeLimitBinding, UnsignedInteger)> {
        self.check(end)?;
        row.running_header()?;
        let policy = self.memory_policy_fields_at(&row.fields_for_limits(), pool_creation)?;
        self.check(end)?;
        let binding = self.observer.source.limits(row, policy.as_ref(), end)?;
        let charge = match (pool_creation, policy.as_ref(), website) {
            (true, Some(policy), WebsiteBinding::Running(site))
                if policy.uses_pool() && policy.high().is_some() =>
            {
                self.observer
                    .source
                    .pool_charge(&self.config, site, row, &binding, policy, end)?
            }
            _ => binding.memory().clone(),
        };
        self.check(end)?;
        Ok((binding, charge))
    }
    fn swap_budget(&self, inventory: &InventoryRows, end: Instant) -> Result<()> {
        let budget = self.config.swap_pool_bytes()?;
        let mut committed = UnsignedInteger::from_u64(0);
        for row in inventory.rows() {
            if row.running()? && row.worker()? {
                committed = committed.plus(&row.swap_commitment()?);
            }
        }
        need(committed <= budget, "Laptop swap admission is full")?;
        if !budget.is_zero() {
            let total = self.observer.source.swap_total(end)?;
            need(
                budget <= total,
                "Laptop swap pool exceeds actual host swap capacity",
            )?;
        }
        Ok(())
    }
}
fn counter(value: &UnsignedInteger) -> Result<CapacityCounter> {
    Ok(CapacityCounter::from_integer(value)?)
}
