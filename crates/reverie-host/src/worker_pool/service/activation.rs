use super::*;
use reverie_contracts::kernel_accounting::HostAccounting;
use reverie_core::capacity::{CapacityCounter, explicit_host_headroom_fits};

impl State {
    pub(super) fn activate(
        &mut self,
        policy: &ControllerPoolPolicy,
        reserve: u32,
        end: Instant,
    ) -> Result<()> {
        need(
            policy.bound_anchor().is_none(),
            "WORKER_POOL_RETAINED_ANCHOR_RESUME_REQUIRED",
        )?;
        self.begin_activation(end)?;
        self.assert_headroom(policy, reserve)?;
        self.anchor.create(policy, end)?;
        let id = self.anchor.id.as_deref().expect("actual original anchor");
        self.directory
            .as_mut()
            .ok_or(PoolError::Refused("WORKER_POOL_DIRECTORY_CLOSED"))?
            .acquire(policy.data(), id, self.anchor.pid)?;
        policy.assert_current()?;
        check(end)?;
        self.directory()?.configure_until(policy.data(), end)?;
        self.directory()?.assert_limits(policy.data())?;
        policy.assert_anchor(id, self.anchor.pid)?;
        self.directory()?.assert_anchor_only(id, self.anchor.pid)?;
        self.assert_headroom(policy, reserve)?;
        check(end)?;
        self.stage = InstallationStage::Confirmed;
        Ok(())
    }

    pub(super) fn resume(
        &mut self,
        policy: &ControllerPoolPolicy,
        reserve: u32,
        end: Instant,
    ) -> Result<()> {
        let anchor = policy
            .bound_anchor()
            .ok_or(PoolError::Refused("WORKER_POOL_RETAINED_ANCHOR_REQUIRED"))?;
        self.begin_activation(end)?;
        // The existing parent remains charged for the same pool. Reopening
        // only reads existing limits and never configures a leaf or parent.
        need(reserve >= 256, "WORKER_POOL_CONTROL_RESERVE")?;
        policy.assert_current()?;
        self.anchor.reopen(policy, anchor, end)?;
        self.directory
            .as_mut()
            .ok_or(PoolError::Refused("WORKER_POOL_DIRECTORY_CLOSED"))?
            .acquire_retained(policy.data(), anchor)?;
        policy.assert_current()?;
        policy.assert_anchor(anchor.container_id(), anchor.pid())?;
        self.directory()?.assert_retained_anchor(anchor)?;
        self.directory()?.assert_limits(policy.data())?;
        check(end)?;
        self.stage = InstallationStage::Confirmed;
        Ok(())
    }

    fn begin_activation(&mut self, end: Instant) -> Result<()> {
        check(end)?;
        need(
            self.stage == InstallationStage::Opening,
            "WORKER_POOL_ACTIVATION_ALREADY_ATTEMPTED",
        )?;
        self.stage = InstallationStage::Attempted;
        Ok(())
    }
    fn assert_headroom(&self, policy: &ControllerPoolPolicy, reserve: u32) -> Result<()> {
        need(reserve >= 256, "WORKER_POOL_CONTROL_RESERVE")?;
        let data = policy.data();
        let raw = policy.engine.inspect(&data.website_container)?;
        let pid =
            reverie_contracts::worker_pool::website_process_data(&raw, &data.website_container)
                .map_err(|_| PoolError::Refused("WORKER_POOL_WEBSITE_IDENTITY"))?
                .ok_or(PoolError::Refused("WORKER_POOL_WEBSITE_STOPPED"))?;
        let value: serde_json::Value = serde_json::from_slice(&raw)
            .map_err(|_| PoolError::Refused("WORKER_POOL_WEBSITE_IDENTITY"))?;
        let memory = value["HostConfig"]["Memory"]
            .as_u64()
            .filter(|n| *n > 0)
            .ok_or(PoolError::Refused("WORKER_POOL_WEBSITE_FINITE_LIMIT"))?;
        need(
            value["HostConfig"]["MemorySwap"].as_u64() == Some(memory)
                && value["HostConfig"]["PidsLimit"]
                    .as_u64()
                    .is_some_and(|n| n > 0 && n <= 4096),
            "WORKER_POOL_WEBSITE_FINITE_LIMIT",
        )?;
        let group = directory::bounded_path(&format!("/proc/{pid}/cgroup"), 4096)?;
        need(
            !group
                .trim()
                .starts_with(&format!("0::/{}/", data.parent_cgroup_relative())),
            "WORKER_POOL_WEBSITE_INSIDE_POOL",
        )?;
        let host = HostAccounting::parse(&directory::bounded_path("/proc/meminfo", 65_536)?)
            .map_err(|_| PoolError::Refused("WORKER_POOL_HOST_ACCOUNTING"))?;
        let counter = |n| {
            CapacityCounter::try_new(n)
                .map_err(|_| PoolError::Refused("WORKER_POOL_HOST_ACCOUNTING"))
        };
        need(
            explicit_host_headroom_fits(
                counter(u64::from(data.memory_max_mi_b) * 1_048_576)?,
                counter(memory)?,
                counter(u64::from(reserve) * 1_048_576)?,
                CapacityCounter::from_integer(host.total())
                    .map_err(|_| PoolError::Refused("WORKER_POOL_HOST_ACCOUNTING"))?,
                CapacityCounter::from_integer(host.available())
                    .map_err(|_| PoolError::Refused("WORKER_POOL_HOST_ACCOUNTING"))?,
            )
            .map_err(|_| PoolError::Refused("WORKER_POOL_HOST_ACCOUNTING"))?,
            "WORKER_POOL_HOST_HEADROOM",
        )?;
        let current = policy.engine.inspect(&data.website_container)?;
        need(
            reverie_contracts::worker_recovery::RecoveryInspection::same_container_object_inspection(
                &data.website_container, &raw, &current,
            )
            .map_err(|_| PoolError::Refused("WORKER_POOL_WEBSITE_IDENTITY"))?,
            "WORKER_POOL_WEBSITE_CHANGED",
        )
    }
}
