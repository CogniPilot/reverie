use super::*;
use reverie_core::decimal::UnsignedInteger;
fn integer(text: &str) -> Result<(bool, UnsignedInteger)> {
    crate::rootless::parse_python_integer(&text.chars().map(u32::from).collect::<Vec<_>>())
        .ok_or(CreationBudgetError::Integer)
}
/// Preserve the raw startswith check; do not resolve '..' or normalize an exact
/// pool root into a child. Native PID/cgroup ownership is separately observed.
pub fn creation_peer_uses_pool(text: &str) -> Result<bool> {
    let lines = crate::kernel_accounting::lines(text);
    if lines.len() != 1 || !lines[0].starts_with("0::/") {
        return Err(CreationBudgetError::Cgroup);
    }
    Ok(lines[0][3..].starts_with("/reverie.slice/reverie-workers.slice/"))
}
pub struct LegacyPoolLimits {
    memory: UnsignedInteger,
}
pub struct LegacyPoolMemory {
    negative: bool,
    memory: UnsignedInteger,
}
impl LegacyPoolLimits {
    pub fn capture_memory(text: &str) -> Result<LegacyPoolMemory> {
        let (negative, memory) = integer(text)?;
        Ok(LegacyPoolMemory { negative, memory })
    }
    pub fn memory(&self) -> &UnsignedInteger {
        &self.memory
    }
}
impl LegacyPoolMemory {
    pub fn finish(self, tasks: &str) -> Result<LegacyPoolLimits> {
        let (negative_tasks, tasks) = integer(tasks)?;
        if self.negative || negative_tasks || self.memory.is_zero() || tasks.is_zero() {
            return Err(CreationBudgetError::Pool);
        }
        Ok(LegacyPoolLimits {
            memory: self.memory,
        })
    }
}
/// The first matching MemTotal row is consumed; unknown units/extras and later
/// duplicates are source-accepted. None represents nonpositive total DATA.
pub fn legacy_memtotal(meminfo: &str) -> Result<Option<UnsignedInteger>> {
    let line = crate::kernel_accounting::lines(meminfo)
        .into_iter()
        .find(|line| line.starts_with("MemTotal:"))
        .ok_or(CreationBudgetError::MissingTotal)?;
    let fields = crate::kernel_accounting::words(line);
    let (negative, total) = integer(fields.get(1).ok_or(CreationBudgetError::ShortTotal)?)?;
    Ok((!negative && !total.is_zero()).then(|| total.times(1024)))
}
