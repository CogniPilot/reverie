use super::{LEAF, encoded, observation, worker_scope, writable, write_checked};
use crate::{
    args::HighWrite,
    data::Resources,
    error::{Result, need},
    files::Files,
    scope::{self, Scope},
};

/// The declared leaf policy. Docker and systemd own `memory.max` and
/// `pids.max` as unit properties, so a reload keeps them; they are asserted,
/// never written. The other three are written by this helper family alone and
/// are what a reload of the service manager resets.
struct Policy<'a> {
    input: &'a HighWrite,
}
impl<'a> Policy<'a> {
    fn new(input: &'a HighWrite) -> Result<Self> {
        need(
            input.worker.worker_start.is_some_and(|value| value > 0)
                && input
                    .worker
                    .common
                    .anchor_start
                    .is_some_and(|value| value > 0),
            "BOXED_RESOURCE_PID_BIRTH_REQUIRED",
        )?;
        need(
            input.memory_high > 0
                && input.memory_high <= input.memory_max
                && input.pids_max > 0
                && (1..=10000).contains(&input.cpu_weight),
            "BOXED_RESOURCE_POLICY",
        )?;
        Ok(Self { input })
    }
    /// What this command never writes must already be the declared policy.
    fn require_owned_by_engine(&self, actual: &Resources) -> Result<()> {
        need(
            actual.memory_max == self.input.memory_max.to_string()
                && actual.pids_max == self.input.pids_max.to_string(),
            "BOXED_RESOURCE_HARD_POLICY_MISMATCH",
        )
    }
    fn writes(&self) -> [(&'static str, String); 3] {
        [
            ("memory.swap.max", self.input.swap_max.to_string()),
            ("memory.high", self.input.memory_high.to_string()),
            ("cpu.weight", self.input.cpu_weight.to_string()),
        ]
    }
    fn require_final(&self, actual: &Resources) -> Result<()> {
        self.require_owned_by_engine(actual)?;
        need(
            actual.swap_max == self.input.swap_max.to_string()
                && actual.memory_high == self.input.memory_high.to_string()
                && actual.cpu_weight == self.input.cpu_weight.to_string(),
            "BOXED_RESOURCE_FINAL_POLICY",
        )
    }
}

// Production supplies only an earned Scope plus its exact writable leaf FD.
// The component test port exercises actual owned files; it cannot mint a Scope.
trait Leaf {
    fn resources(&mut self) -> Result<Resources>;
    fn write(&mut self, name: &str, value: &str) -> Result<()>;
}
fn apply(leaf: &mut impl Leaf, policy: &Policy<'_>) -> Result<()> {
    policy.require_owned_by_engine(&leaf.resources()?)?;
    for (name, value) in policy.writes() {
        leaf.write(name, &value)?;
    }
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
    fn write(&mut self, name: &str, value: &str) -> Result<()> {
        write_checked(
            self.files,
            self.scope,
            self.index,
            self.expected,
            name,
            value,
        )
    }
}

pub(super) fn restore(files: &mut Files, input: &HighWrite) -> Result<String> {
    let policy = Policy::new(input)?;
    let scope = worker_scope(files, &input.worker)?;
    let target = scope.worker(&input.worker.worker_id)?;
    let expected = (input.leaf_dev, input.leaf_ino);
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
    let result = observation(files, &scope, Some(&input.worker.worker_id))?;
    policy.require_final(&result.resources)?;
    encoded(&result)
}

#[cfg(test)]
mod tests;
