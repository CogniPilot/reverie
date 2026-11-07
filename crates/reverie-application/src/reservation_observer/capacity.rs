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
        let mut total = UnsignedInteger::from_u64(0);
        let mut commitments = Vec::new();
        for row in inventory.rows.rows() {
            self.check(end)?;
            // Source validates every row's labels and strict running flag, then
            // worker PID consistency, even for another deployment's workers.
            let worker = row.worker()?;
            let running = row.running()?;
            if worker {
                let pid = row
                    .pid()
                    .map_err(|_| ObserverError::Refused("RESERVATION_NATIVE_STATE"))?;
                need(pid.is_zero() != running, "RESERVATION_NATIVE_STATE")?;
            }
            if worker && running {
                let binding = self.limits_at(row, end)?;
                total = total.plus(binding.memory());
                commitments.push(binding);
            }
        }
        if self.config.memory_policies_enabled() {
            self.swap_budget(&inventory.rows, end)?;
        }
        let budget = self.config.pool_bytes()?;
        need(
            capacity::explicit_host_headroom_fits(
                counter(&budget)?,
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
        self.check(end)?;
        Ok(CapacityFacts {
            total,
            budget,
            website,
            commitments,
        })
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
