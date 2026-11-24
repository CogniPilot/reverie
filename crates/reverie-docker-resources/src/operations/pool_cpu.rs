//! Group CPU ceiling for one declared pool. The only kernel write is cpu.max,
//! so every running member keeps its process, leaf limits and identity.
use super::{encoded, observation, writable, write_checked};
use crate::{
    args::{CpuCeiling, PoolCpuMaxWrite},
    data::{self, Resources},
    error::{Error, Result, need},
    files::Files,
    scope::{self, Scope},
};
use serde::Serialize;
use std::collections::BTreeSet;

/// The kernel's default bandwidth period in microseconds. A fixed period keeps
/// one approved CPU count equal to exactly one cpu.max value.
const PERIOD_MICROS: u64 = 100_000;

struct Policy<'a> {
    input: &'a PoolCpuMaxWrite,
    cpus: BTreeSet<u32>,
    cpu_max: String,
}
impl<'a> Policy<'a> {
    fn new(input: &'a PoolCpuMaxWrite) -> Result<Self> {
        let pool = &input.pool;
        need(
            pool.common.anchor_start.is_some_and(|value| value > 0),
            "BOXED_RESOURCE_ANCHOR_BIRTH_REQUIRED",
        )?;
        super::pool::require_bound_members(&pool.common)?;
        need(
            pool.memory_max > 0 && pool.pids_max > 0 && (1..=10000).contains(&pool.cpu_weight),
            "BOXED_RESOURCE_POLICY",
        )?;
        let cpus = data::cpus(
            pool.cpuset_cpus
                .as_deref()
                .ok_or(Error::Refused("BOXED_RESOURCE_CPU_SET_REQUIRED"))?,
        )?;
        need(!cpus.is_empty(), "BOXED_RESOURCE_CPU_SET_BOUND")?;
        let cpu_max = match input.cpu_max_cores {
            CpuCeiling::Unlimited => format!("max {PERIOD_MICROS}"),
            CpuCeiling::Cores(cores) => {
                // A ceiling above the pool's own CPU set would limit nothing.
                need(
                    usize::try_from(cores).is_ok_and(|cores| cores <= cpus.len()),
                    "BOXED_RESOURCE_CPU_CEILING_UNAVAILABLE",
                )?;
                format!("{} {PERIOD_MICROS}", u64::from(cores) * PERIOD_MICROS)
            }
        };
        Ok(Self {
            input,
            cpus,
            cpu_max,
        })
    }
    fn require_other(&self, actual: &Resources) -> Result<()> {
        let expected = &self.input.pool;
        need(
            actual.memory_max == expected.memory_max.to_string()
                && actual.swap_max == expected.swap_max.to_string()
                && actual.pids_max == expected.pids_max.to_string()
                && actual.memory_high == "max"
                && actual.cpu_weight == expected.cpu_weight.to_string()
                && data::cpus(&actual.cpuset_cpus)? == self.cpus
                && data::cpus(&actual.cpuset_cpus_effective)? == self.cpus,
            "BOXED_RESOURCE_OTHER_POLICY_MISMATCH",
        )
    }
    fn require_final(&self, actual: &Resources) -> Result<()> {
        self.require_other(actual)?;
        need(
            actual.cpu_max == self.cpu_max,
            "BOXED_RESOURCE_FINAL_POLICY",
        )
    }
}

/** The write interface has no memory, weight, CPU set or path operation.
 * Production creates it only after the original kernel Scope and the exact
 * writable pool parent are earned. */
trait Ceiling {
    fn resources(&mut self) -> Result<Resources>;
    fn write_cpu_max(&mut self, value: &str) -> Result<()>;
}
fn apply(pool: &mut impl Ceiling, policy: &Policy<'_>) -> Result<()> {
    policy.require_other(&pool.resources()?)?;
    pool.write_cpu_max(&policy.cpu_max)?;
    policy.require_final(&pool.resources()?)
}
struct ScopedCeiling<'a> {
    files: &'a mut Files,
    scope: &'a Scope,
    index: usize,
    expected: (u64, u64),
}
impl Ceiling for ScopedCeiling<'_> {
    fn resources(&mut self) -> Result<Resources> {
        self.scope.assert_current(self.files)?;
        need(
            self.files.identity(self.index)? == self.expected,
            "BOXED_RESOURCE_PARENT_CHANGED",
        )?;
        let resources = scope::resources(self.files, self.index)?;
        self.scope.assert_current(self.files)?;
        Ok(resources)
    }
    fn write_cpu_max(&mut self, value: &str) -> Result<()> {
        write_checked(
            self.files,
            self.scope,
            self.index,
            self.expected,
            "cpu.max",
            value,
        )
    }
}

pub(super) fn configure(files: &mut Files, input: &PoolCpuMaxWrite) -> Result<String> {
    let policy = Policy::new(input)?;
    let pool = &input.pool;
    let scope = Scope::capture(files, &pool.common)?;
    let expected = (pool.parent_dev, pool.parent_ino);
    need(
        files.identity(scope.parent)? == expected,
        "BOXED_RESOURCE_PARENT_CHANGED",
    )?;
    let index = writable(files, "/run/reverie-box-pool", expected)?;
    apply(
        &mut ScopedCeiling {
            files,
            scope: &scope,
            index,
            expected,
        },
        &policy,
    )?;
    let result = observation(files, &scope, None)?;
    policy.require_final(&result.resources)?;
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct CpuMaxAck<'a> {
        version: u8,
        purpose: &'static str,
        observation: super::Observation<'a>,
        members: Vec<&'a scope::Identity>,
    }
    encoded(&CpuMaxAck {
        version: 1,
        purpose: "reverie-boxed-pool-cpu-max-ack-v1",
        observation: result,
        members: scope
            .processes
            .iter()
            .skip(1)
            .map(|process| &process.identity)
            .collect(),
    })
}

#[cfg(test)]
mod tests;
