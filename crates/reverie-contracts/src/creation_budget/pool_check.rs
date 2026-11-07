use super::*;
use reverie_core::decimal::UnsignedInteger;
struct Signed {
    negative: bool,
    value: UnsignedInteger,
}
fn integer(text: &str) -> Result<Signed> {
    let (negative, value) =
        crate::rootless::parse_python_integer(&text.chars().map(u32::from).collect::<Vec<_>>())
            .ok_or(CreationBudgetError::PoolActivation)?;
    Ok(Signed { negative, value })
}
fn exceeds(value: &Signed, limit: u64) -> bool {
    !value.negative && value.value > UnsignedInteger::from_u64(limit)
}
fn has_headroom(tasks: &Signed, current: &Signed) -> bool {
    let margin = UnsignedInteger::from_u64(64);
    match (tasks.negative, current.negative) {
        (false, false) => tasks.value >= current.value.plus(&margin),
        (false, true) => tasks.value.plus(&current.value) >= margin,
        (true, false) => false,
        (true, true) => current.value >= tasks.value.plus(&margin),
    }
}
/// Broker.check_pool's distinct legacy rule: no new positivity restriction is
/// added, and current is parsed before the memory/tasks conditional. Bounds
/// are supplied DATA from the already checked resource policy, not authority.
pub fn check_pool_counters(
    memory: &str,
    tasks: &str,
    current: &str,
    maximum_memory: u64,
    maximum_tasks: u32,
    require_headroom: bool,
) -> Result<()> {
    let current = integer(current)?;
    let memory = crate::kernel_accounting::strip(memory);
    let tasks = crate::kernel_accounting::strip(tasks);
    if memory == "max" || exceeds(&integer(memory)?, maximum_memory) || tasks == "max" {
        return Err(CreationBudgetError::PoolActivation);
    }
    let tasks = integer(tasks)?;
    if exceeds(&tasks, u64::from(maximum_tasks)) {
        return Err(CreationBudgetError::PoolActivation);
    }
    if require_headroom && !has_headroom(&tasks, &current) {
        return Err(CreationBudgetError::TaskHeadroom);
    }
    Ok(())
}
