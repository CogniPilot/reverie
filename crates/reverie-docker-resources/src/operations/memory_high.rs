use super::{LEAF, encoded, observation, worker_scope, writable, write_checked};
use crate::{
    args::MemoryHighWrite,
    data::{self, Resources},
    error::{Result, need},
    files::Files,
    scope::{self, Scope},
};
use std::collections::BTreeSet;

struct Policy<'a> {
    input: &'a MemoryHighWrite,
    cpus: BTreeSet<u32>,
}
impl<'a> Policy<'a> {
    fn new(input: &'a MemoryHighWrite) -> Result<Self> {
        let high = &input.high;
        need(
            high.memory_high > 0
                && high.memory_high.is_multiple_of(4096)
                && high.memory_high <= high.memory_max
                && high.pids_max > 0
                && (1..=10000).contains(&high.cpu_weight),
            "BOXED_RESOURCE_POLICY",
        )?;
        let cpus = data::cpus(&input.cpuset_cpus)?;
        need(
            !cpus.is_empty() && cpus.len() <= 256,
            "BOXED_RESOURCE_CPU_SET_BOUND",
        )?;
        Ok(Self { input, cpus })
    }
    fn require_other(&self, actual: &Resources) -> Result<()> {
        let expected = &self.input.high;
        need(
            actual.memory_max == expected.memory_max.to_string()
                && actual.swap_max == expected.swap_max.to_string()
                && actual.pids_max == expected.pids_max.to_string()
                && actual.cpu_weight == expected.cpu_weight.to_string()
                && actual
                    .cpu_max
                    .split_once(' ')
                    .is_some_and(|(quota, period)| {
                        quota == "max" && crate::args::decimal(period).is_ok_and(|value| value > 0)
                    })
                && data::cpus(&actual.cpuset_cpus)? == self.cpus
                && data::cpus(&actual.cpuset_cpus_effective)? == self.cpus,
            "BOXED_RESOURCE_OTHER_POLICY_MISMATCH",
        )
    }
    fn require_final(&self, actual: &Resources) -> Result<()> {
        self.require_other(actual)?;
        need(
            actual.memory_high == self.input.high.memory_high.to_string(),
            "BOXED_RESOURCE_FINAL_POLICY",
        )
    }
}

/** The write interface has no CPU/hard-limit/path operation. Production creates
 * it only after the original kernel Scope and exact writable leaf are earned. */
trait Leaf {
    fn resources(&mut self) -> Result<Resources>;
    fn write_memory_high(&mut self, value: &str) -> Result<()>;
}
fn apply(leaf: &mut impl Leaf, policy: &Policy<'_>) -> Result<()> {
    policy.require_other(&leaf.resources()?)?;
    leaf.write_memory_high(&policy.input.high.memory_high.to_string())?;
    policy.require_final(&leaf.resources()?)
}
struct ScopedLeaf<'a> {
    files: &'a mut Files,
    scope: &'a Scope,
    index: usize,
    expected: (u64, u64),
}
impl Leaf for ScopedLeaf<'_> {
    fn resources(&mut self) -> Result<Resources> {
        self.scope.assert_current(self.files)?;
        need(
            self.files.identity(self.index)? == self.expected,
            "BOXED_RESOURCE_LEAF_CHANGED",
        )?;
        let resources = scope::resources(self.files, self.index)?;
        self.scope.assert_current(self.files)?;
        Ok(resources)
    }
    fn write_memory_high(&mut self, value: &str) -> Result<()> {
        write_checked(
            self.files,
            self.scope,
            self.index,
            self.expected,
            "memory.high",
            value,
        )
    }
}

pub(super) fn configure(files: &mut Files, input: &MemoryHighWrite) -> Result<String> {
    let policy = Policy::new(input)?;
    let high = &input.high;
    need(
        high.worker.worker_start.is_some_and(|value| value > 0)
            && high
                .worker
                .common
                .anchor_start
                .is_some_and(|value| value > 0),
        "BOXED_RESOURCE_PID_BIRTH_REQUIRED",
    )?;
    let scope = worker_scope(files, &high.worker)?;
    let target = scope.worker(&high.worker.worker_id)?;
    let expected = (high.leaf_dev, high.leaf_ino);
    need(
        files.identity(target)? == expected,
        "BOXED_RESOURCE_LEAF_CHANGED",
    )?;
    let index = writable(files, &LEAF, expected)?;
    apply(
        &mut ScopedLeaf {
            files,
            scope: &scope,
            index,
            expected,
        },
        &policy,
    )?;
    let result = observation(files, &scope, Some(&high.worker.worker_id))?;
    policy.require_final(&result.resources)?;
    encoded(&result)
}

#[cfg(test)]
mod tests;
