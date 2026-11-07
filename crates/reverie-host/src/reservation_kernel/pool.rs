//! Soft admission discount requires the installed aggregate hard ceiling and
//! current physical member. Historical bindings keep their original hard cap.
use super::*;
use reverie_contracts::{
    kernel_accounting::{CgroupMembership, ControllerLimit},
    reservation_engine::NativeLimitBinding,
};
const POOL: &str = "/sys/fs/cgroup/reverie.slice/reverie-workers.slice";
const RELATIVE: &str = "reverie.slice/reverie-workers.slice";

/// One fixed native snapshot. It is neither an allocation nor write authority.
pub(super) struct ProtectedPoolMemory {
    maximum: UnsignedInteger,
    high: UnsignedInteger,
    identity: [u64; 4],
}
pub(super) fn capture(
    source: &impl Source,
    config: &ReservationConfiguration,
    website: &NativeLimitBinding,
    end: Instant,
) -> Result<ProtectedPoolMemory> {
    need(
        config.cgroup_parent()? == "reverie-workers.slice",
        "RESERVATION_POOL_PARENT_UNSUPPORTED",
    )?;
    host_root(source, end)?;
    let membership =
        CgroupMembership::observer(&text(source, &path("/proc/self/cgroup"), 65536, true, end)?)?;
    need(
        !inside(membership.relative()) && !inside(&website.cgroup()?),
        "RESERVATION_POOL_CONTROL_INSIDE",
    )?;
    binding_current(source, website, end)?;
    let root = path(POOL);
    let identity = source.identity(&root)?;
    need(source.resolve(&root)? == root, "RESERVATION_POOL_REBOUND")?;
    let maximum = finite(source, &root, "memory.max", end)?;
    let high = finite(source, &root, "memory.high", end)?;
    need(
        maximum == config.pool_bytes()? && !high.is_zero() && high < maximum,
        "RESERVATION_POOL_LIMITS_CHANGED",
    )?;
    let mut parent = root.parent();
    loop {
        let limit = ControllerLimit::memory_or_tasks(&text(
            source,
            &join(&parent, "memory.max"),
            128,
            true,
            end,
        )?)?;
        need(
            !matches!(limit, ControllerLimit::Finite(value) if value < maximum),
            "RESERVATION_POOL_ANCESTOR_LIMIT",
        )?;
        if parent == path(CGROUP) {
            break;
        }
        parent = parent.parent();
    }
    let observed = ProtectedPoolMemory {
        maximum,
        high,
        identity,
    };
    current(source, &observed, end)?;
    binding_current(source, website, end)?;
    need(
        membership.matches(&text(source, &path("/proc/self/cgroup"), 65536, true, end)?),
        "RESERVATION_POOL_OBSERVER_CHANGED",
    )?;
    Ok(observed)
}
pub(super) fn charge(
    source: &impl Source,
    config: &ReservationConfiguration,
    website: &NativeLimitBinding,
    row: &ContainerRow,
    observed: &NativeLimitBinding,
    policy: &ObservedMemoryPolicy,
    end: Instant,
) -> Result<UnsignedInteger> {
    let high = policy.high().ok_or(ReservationKernelError::Refused(
        "RESERVATION_POOL_SOFT_POLICY_REQUIRED",
    ))?;
    need(
        policy.uses_pool() && !high.is_zero() && high < policy.memory(),
        "RESERVATION_POOL_SOFT_POLICY_REQUIRED",
    )?;
    let pool = capture(source, config, website, end)?;
    let group = observed.cgroup()?;
    need(
        row.id() == observed.container_id() && group != path(RELATIVE) && inside(&group),
        "RESERVATION_POOL_MEMBER_REQUIRED",
    )?;
    let fresh = limits::observe(source, row, Some(policy), end)?.into_binding();
    need(
        fresh.canonical_bytes() == observed.canonical_bytes(),
        "RESERVATION_POOL_MEMBER_CHANGED",
    )?;
    need(
        fresh.memory() == policy.memory(),
        "RESERVATION_POOL_MEMBER_CHANGED",
    )?;
    current(source, &pool, end)?;
    binding_current(source, &fresh, end)?;
    Ok(high.clone())
}
fn inside(group: &PosixPath) -> bool {
    group.relative_to(&path(RELATIVE)).is_some()
}
fn binding_current(source: &impl Source, binding: &NativeLimitBinding, end: Instant) -> Result<()> {
    let pid = binding.pid()?;
    let start = pid_start(source, &pid, end)?;
    let groups = text(
        source,
        &path(&format!("{PROC}/{}/cgroup", pid.as_str())),
        65536,
        true,
        end,
    )?;
    let membership = CgroupMembership::container(&groups)?;
    need(
        binding.start_matches(&start)? && *membership.relative() == binding.cgroup()?,
        "RESERVATION_POOL_PROCESS_CHANGED",
    )?;
    Ok(())
}
fn finite(
    source: &impl Source,
    root: &PosixPath,
    name: &str,
    end: Instant,
) -> Result<UnsignedInteger> {
    match ControllerLimit::memory_or_tasks(&text(source, &join(root, name), 128, true, end)?)? {
        ControllerLimit::Finite(value) => Ok(value),
        ControllerLimit::Unlimited => Err(ReservationKernelError::Refused(
            "RESERVATION_POOL_FINITE_REQUIRED",
        )),
    }
}
pub(super) fn current(
    source: &impl Source,
    observed: &ProtectedPoolMemory,
    end: Instant,
) -> Result<()> {
    let root = path(POOL);
    need(
        source.identity(&root)? == observed.identity
            && source.resolve(&root)? == root
            && finite(source, &root, "memory.max", end)? == observed.maximum
            && finite(source, &root, "memory.high", end)? == observed.high,
        "RESERVATION_POOL_REBOUND",
    )
}
