use super::*;
use reverie_contracts::{
    creation_budget::{LegacyPoolLimits, PeerProcessId},
    kernel_accounting,
};
use reverie_core::decimal::UnsignedInteger;
use reverie_core::resources::{BudgetMode, ResourcePolicy};
use std::path::Path;
const POOL: &str = "/sys/fs/cgroup/reverie.slice/reverie-workers.slice";
#[cfg(test)]
mod tests;
trait Source {
    fn text(&self, path: &str) -> Result<String>;
}
struct Installed;
impl Source for Installed {
    fn text(&self, path: &str) -> Result<String> {
        let bytes = crate::native::read_reservation(Path::new(path), 65_536)?;
        String::from_utf8(bytes).map_err(|_| CreationHostError::Encoding)
    }
}
fn read(source: &impl Source, path: &str, end: Instant) -> Result<String> {
    check(end)?;
    let text = source.text(path)?;
    check(end)?;
    // TextIOWrapper's universal newline translation, without ASCII tightening.
    Ok(text.replace("\r\n", "\n").replace('\r', "\n"))
}
fn check(end: Instant) -> Result<()> {
    if Instant::now() < end {
        Ok(())
    } else {
        Err(CreationHostError::Deadline)
    }
}
/// Fixed proc/cgroup snapshot reader. No caller path, PID string, environment
/// root selector, cgroup custody or effect/start grant is accepted here.
pub struct CreationKernel;
impl CreationKernel {
    pub fn check_pool(
        resources: &ResourcePolicy,
        require_headroom: bool,
        end: Instant,
    ) -> Result<()> {
        check_pool(&Installed, resources, require_headroom, end)
    }
    pub fn peer_uses_pool(pid: &PeerProcessId, end: Instant) -> Result<bool> {
        Ok(reverie_contracts::creation_budget::creation_peer_uses_pool(
            &read(&Installed, &format!("/proc/{}/cgroup", pid.decimal()), end)?,
        )?)
    }
    pub fn legacy_pool(end: Instant) -> Result<LegacyPoolLimits> {
        pool(&Installed, end)
    }
    pub fn legacy_total(end: Instant) -> Result<Option<UnsignedInteger>> {
        total(&Installed, end)
    }
    pub fn swap_total(end: Instant) -> Result<UnsignedInteger> {
        kernel_accounting::swap_total(&read(&Installed, "/proc/meminfo", end)?)
            .map_err(CreationHostError::KernelData)
    }
}
fn check_pool(
    source: &impl Source,
    resources: &ResourcePolicy,
    require_headroom: bool,
    end: Instant,
) -> Result<()> {
    if resources.budget_mode() == BudgetMode::Admission {
        return Ok(());
    }
    let counters = (|| {
        let memory = read(source, &format!("{POOL}/memory.max"), end)?;
        let tasks = read(source, &format!("{POOL}/pids.max"), end)?;
        let current = read(source, &format!("{POOL}/pids.current"), end)?;
        Ok((memory, tasks, current))
    })();
    let (memory, tasks, current) = counters.map_err(|cause| CreationHostError::PoolActivation {
        cause: Box::new(cause),
    })?;
    Ok(reverie_contracts::creation_budget::check_pool_counters(
        &memory,
        &tasks,
        &current,
        u64::from(resources.pool_memory_mib()) * 1_048_576,
        resources.pool_tasks_max(),
        require_headroom,
    )?)
}
fn pool(source: &impl Source, end: Instant) -> Result<LegacyPoolLimits> {
    let memory =
        LegacyPoolLimits::capture_memory(&read(source, &format!("{POOL}/memory.max"), end)?)?;
    let tasks = read(source, &format!("{POOL}/pids.max"), end)?;
    Ok(memory.finish(&tasks)?)
}
fn total(source: &impl Source, end: Instant) -> Result<Option<UnsignedInteger>> {
    Ok(reverie_contracts::creation_budget::legacy_memtotal(&read(
        source,
        "/proc/meminfo",
        end,
    )?)?)
}
