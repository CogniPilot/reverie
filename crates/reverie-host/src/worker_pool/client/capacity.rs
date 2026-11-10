//! Borrow the actual controller for one bounded capacity observation. Neither
//! returned counters nor container DATA authorize a create, start or release.
use super::*;
use crate::engine_metadata::ReadonlyEngine;
use reverie_contracts::reservation_engine::{ContainerRow, NativeLimitBinding};
use reverie_core::{decimal::UnsignedInteger, posix_path::PosixPath};

mod controller;
mod member;

pub struct ControllerCapacity<'owner> {
    owner: &'owner mut ControllerState,
    end: Instant,
    parent_bytes: u64,
    website: NativeLimitBinding,
}
impl ActivatedController {
    /// Captures no new runtime, daemon or authority. The caller must retain
    /// the same exclusive controller custody until the final currentness check.
    pub fn observe_capacity(
        &mut self,
        engine: &ReadonlyEngine,
        policy: &WorkerPoolPolicy,
        website: &NativeLimitBinding,
        end: Instant,
    ) -> Result<ControllerCapacity<'_>> {
        let owner = self.state_mut();
        owner
            .query
            .assert_engine(engine)
            .map_err(PoolError::Engine)?;
        need(
            owner.policy == *policy,
            "WORKER_POOL_CAPACITY_POLICY_CHANGED",
        )?;
        need(
            policy.broker_uid == native::uid()
                && policy.broker_gid == nix::unistd::getgid().as_raw(),
            "WORKER_POOL_NATIVE_BROKER_IDS",
        )?;
        let end = owner
            .binding
            .stop
            .deadline()
            .map_or(end, |stop| end.min(stop));
        let result = capture(owner, website, end);
        let parent_bytes = owner.retain_capacity_result(result)?;
        Ok(ControllerCapacity {
            owner,
            end,
            parent_bytes,
            website: website.clone(),
        })
    }
}
impl ControllerCapacity<'_> {
    /// Actual retained-parent readback, including when no employee is running.
    pub fn parent_memory_bytes(&self) -> u64 {
        self.parent_bytes
    }
    /// The controller's separately observed hard ceiling is outside the parent.
    pub fn outside_controller_memory_bytes(&self) -> u64 {
        reverie_contracts::worker_pool::CONTROLLER_MEMORY_BYTES
    }
    pub fn incremental_memory(
        &mut self,
        row: &ContainerRow,
        binding: &NativeLimitBinding,
    ) -> Result<UnsignedInteger> {
        let result = self.member_charge(row, binding);
        self.owner.retain_capacity_result(result)
    }
    pub fn assert_current(&mut self) -> Result<()> {
        let result = capture(self.owner, &self.website, self.end).and_then(|bytes| {
            need(
                bytes == self.parent_bytes,
                "WORKER_POOL_CAPACITY_PARENT_CHANGED",
            )
        });
        self.owner.retain_capacity_result(result)
    }
    fn member_charge(
        &mut self,
        row: &ContainerRow,
        binding: &NativeLimitBinding,
    ) -> Result<UnsignedInteger> {
        check_end(self.owner, self.end)?;
        need(
            row.id() == binding.container_id(),
            "WORKER_POOL_CAPACITY_MEMBER_CHANGED",
        )?;
        let parent = PosixPath::from_scalar_text(&self.owner.policy.parent_cgroup_relative());
        let group = binding
            .cgroup()
            .map_err(|_| PoolError::Refused("WORKER_POOL_CAPACITY_GROUP"))?;
        if !group.is_relative_to(&parent)
            || !row
                .label_is("reverie.worker", &self.owner.policy.deployment)
                .map_err(|_| PoolError::Refused("WORKER_POOL_CAPACITY_MEMBER_LABELS"))?
        {
            return Ok(binding.memory().clone());
        }
        if !member::observe(self.owner, row, binding, self.end)? {
            return Ok(binding.memory().clone());
        }
        Ok(UnsignedInteger::from_u64(0))
    }
}
impl ControllerState {
    fn retain_capacity_result<T>(&mut self, result: Result<T>) -> Result<T> {
        match result {
            Ok(value) => Ok(value),
            Err(error) => {
                self.close_unknown |= error.close_unknown();
                if self.capacity_failure.is_none() {
                    self.capacity_failure = Some(Box::new(error));
                }
                Err(PoolError::Refused("WORKER_POOL_CAPACITY_RETAINED"))
            }
        }
    }
}
fn capture(owner: &mut ControllerState, website: &NativeLimitBinding, end: Instant) -> Result<u64> {
    check_end(owner, end)?;
    let parent = PosixPath::from_scalar_text(&owner.policy.parent_cgroup_relative());
    let own_group = reverie_contracts::kernel_accounting::CgroupMembership::observer(
        &directory::bounded_path("/proc/self/cgroup", 4096)?,
    )
    .map_err(|_| PoolError::Refused("WORKER_POOL_CAPACITY_OBSERVER"))?;
    need(
        !own_group.relative().is_relative_to(&parent),
        "WORKER_POOL_CAPACITY_OBSERVER_INSIDE",
    )?;
    let group = website
        .cgroup()
        .map_err(|_| PoolError::Refused("WORKER_POOL_CAPACITY_WEBSITE"))?;
    need(
        !group.is_relative_to(&parent),
        "WORKER_POOL_CAPACITY_WEBSITE_INSIDE",
    )?;
    let pid = website
        .pid()
        .map_err(|_| PoolError::Refused("WORKER_POOL_CAPACITY_WEBSITE"))?;
    let start = directory::process_start(
        pid.to_u64()
            .and_then(|pid| u32::try_from(pid).ok())
            .ok_or(PoolError::Refused("WORKER_POOL_CAPACITY_WEBSITE"))?,
    )?;
    need(
        website
            .start_matches(&start)
            .map_err(|_| PoolError::Refused("WORKER_POOL_CAPACITY_WEBSITE"))?,
        "WORKER_POOL_CAPACITY_WEBSITE_CHANGED",
    )?;
    let expected = group
        .codepoints()
        .into_iter()
        .map(char::from_u32)
        .collect::<Option<String>>()
        .ok_or(PoolError::Refused("WORKER_POOL_CAPACITY_WEBSITE"))?;
    need(
        directory::bounded_path(&format!("/proc/{}/cgroup", pid.as_str()), 4096)?
            == format!("0::/{expected}\n"),
        "WORKER_POOL_CAPACITY_WEBSITE_CHANGED",
    )?;
    let bytes = observe_parent(owner, end)?;
    need(
        directory::process_start(
            pid.to_u64()
                .and_then(|pid| u32::try_from(pid).ok())
                .ok_or(PoolError::Refused("WORKER_POOL_CAPACITY_WEBSITE"))?,
        )? == start,
        "WORKER_POOL_CAPACITY_WEBSITE_CHANGED",
    )?;
    need(
        directory::bounded_path(&format!("/proc/{}/cgroup", pid.as_str()), 4096)?
            == format!("0::/{expected}\n"),
        "WORKER_POOL_CAPACITY_WEBSITE_CHANGED",
    )?;
    Ok(bytes)
}
fn observe_parent(owner: &mut ControllerState, end: Instant) -> Result<u64> {
    check_end(owner, end)?;
    owner.assert_original_controller_current(end)?;
    let raw = owner
        .query
        .query(
            EngineQuery::WorkerPoolInformation,
            end,
            &owner.binding.engine.cancellation(),
        )
        .map_err(PoolError::Engine)?;
    reverie_contracts::worker_pool::validate_engine_information(raw.as_bytes(), &owner.policy)
        .map_err(|_| PoolError::Refused("WORKER_POOL_CAPACITY_ENGINE"))?;
    controller::observe(owner, end)?;
    let parent = owner.directory.parent()?;
    let bytes = directory::read_at(parent, "memory.max")?
        .trim()
        .parse::<u64>()
        .map_err(|_| PoolError::Refused("WORKER_POOL_CAPACITY_PARENT"))?;
    need(
        bytes == u64::from(owner.policy.memory_max_mi_b) * 1_048_576,
        "WORKER_POOL_CAPACITY_PARENT",
    )?;
    owner.assert_original_controller_current(end)?;
    check_end(owner, end)?;
    Ok(bytes)
}
fn check_end(owner: &ControllerState, end: Instant) -> Result<()> {
    owner.require_active()?;
    let end = owner
        .binding
        .stop
        .deadline()
        .map_or(end, |stop| stop.min(end));
    need(Instant::now() < end, "WORKER_POOL_CAPACITY_DEADLINE")
}
