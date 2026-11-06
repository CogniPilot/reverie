use super::*;
use reverie_contracts::{
    kernel_accounting::{CgroupMembership, ControllerLimit, strip},
    reservation_engine::NativeLimitBinding,
};
pub struct LimitsObservation {
    binding: NativeLimitBinding,
}
impl LimitsObservation {
    pub fn binding(&self) -> &NativeLimitBinding {
        &self.binding
    }
    pub fn into_binding(self) -> NativeLimitBinding {
        self.binding
    }
}
pub(super) fn observe(
    source: &impl Source,
    row: &ContainerRow,
    policy: Option<&ObservedMemoryPolicy>,
    end: Instant,
) -> Result<LimitsObservation> {
    let zero = UnsignedInteger::from_u64(0);
    let swap = policy.map_or(&zero, ObservedMemoryPolicy::swap);
    let declared = row.declarations(swap)?;
    let start = pid_start(source, declared.pid(), end)?;
    row.image()?; // Preserve source's image check after the first PID read.
    let group_path = path(&format!("{PROC}/{}/cgroup", declared.pid().as_str()));
    let group = CgroupMembership::container(&text(source, &group_path, 65536, true, end)?)?;
    let leaf = path(CGROUP).join(group.relative());
    let (memory_min, tasks_min) = ancestors(source, &leaf, end)?;
    for (name, expected) in [
        ("memory.max", declared.memory()),
        ("memory.swap.max", swap),
        ("pids.max", declared.tasks()),
    ] {
        need(
            strip(&text(source, &join(&leaf, name), 128, true, end)?) == expected.as_str(),
            "RESERVATION_EFFECTIVE_LIMIT_CONFLICT",
        )?;
    }
    need(
        memory_min.as_ref() == Some(declared.memory())
            && tasks_min.as_ref() == Some(declared.tasks()),
        "RESERVATION_EFFECTIVE_LIMIT_CONFLICT",
    )?;
    if let Some(policy) = policy {
        soft(source, &leaf, policy, end)?;
    }
    need(
        pid_start(source, declared.pid(), end)? == start
            && group.matches(&text(source, &group_path, 65536, true, end)?),
        "RESERVATION_NATIVE_PID_CHANGED",
    )?;
    Ok(LimitsObservation {
        binding: NativeLimitBinding::from_observed_data(
            row,
            &declared,
            &start,
            group.relative(),
            policy,
        )?,
    })
}
fn ancestors(
    source: &impl Source,
    leaf: &PosixPath,
    end: Instant,
) -> Result<(Option<UnsignedInteger>, Option<UnsignedInteger>)> {
    let root = path(CGROUP);
    let mut current = leaf.clone();
    let mut memory = Vec::new();
    let mut tasks = Vec::new();
    loop {
        for (name, values) in [("memory.max", &mut memory), ("pids.max", &mut tasks)] {
            let selected = join(&current, name);
            if current == root && !source.exists(&selected)? {
                continue;
            }
            if let ControllerLimit::Finite(value) =
                ControllerLimit::memory_or_tasks(&text(source, &selected, 128, true, end)?)?
            {
                values.push(value);
            }
        }
        if current == root {
            break;
        }
        let parent = current.parent();
        need(parent != current, "RESERVATION_NATIVE_CGROUP")?;
        current = parent;
    }
    Ok((memory.into_iter().min(), tasks.into_iter().min()))
}
fn soft(
    source: &impl Source,
    leaf: &PosixPath,
    policy: &ObservedMemoryPolicy,
    end: Instant,
) -> Result<()> {
    let high = policy.high().map_or("max", UnsignedInteger::as_str);
    need(
        strip(&text(source, &join(leaf, "memory.high"), 128, true, end)?) == high,
        "RESERVATION_EFFECTIVE_SOFT_LIMIT_CONFLICT",
    )?;
    let root = path(CGROUP);
    let mut current = leaf.clone();
    while current != root {
        let value = ControllerLimit::swap(&text(
            source,
            &join(&current, "memory.swap.max"),
            128,
            true,
            end,
        )?)
        .map_err(|_| ReservationKernelError::Refused("RESERVATION_EFFECTIVE_SWAP_CONFLICT"))?;
        need(
            matches!(value, ControllerLimit::Unlimited)
                || matches!(value,ControllerLimit::Finite(ref value) if value>=policy.swap()),
            "RESERVATION_EFFECTIVE_SWAP_CONFLICT",
        )?;
        current = current.parent();
    }
    Ok(())
}
