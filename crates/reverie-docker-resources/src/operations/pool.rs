use super::{POOL, encoded, observation, writable, write_checked};
use crate::{
    args::{Common, PoolWrite},
    data::{self, Resources},
    error::{Result, need},
    files::Files,
    scope::{self, Scope},
};
use serde::Serialize;
use std::collections::BTreeSet;

pub(super) fn require_restore_members(common: &Common) -> Result<()> {
    need(
        !common.member.is_empty() && common.member.len() <= 64,
        "BOXED_RESOURCE_RESTORE_MEMBERS_REQUIRED",
    )?;
    need(
        common.member.iter().all(|member| member.start > 0),
        "BOXED_RESOURCE_PID_BIRTH_REQUIRED",
    )?;
    let mut ids = BTreeSet::from([common.anchor_id.as_str()]);
    let mut pids = BTreeSet::from([common.anchor_pid]);
    need(
        common
            .member
            .iter()
            .all(|member| ids.insert(&member.id) && pids.insert(member.pid)),
        "BOXED_RESOURCE_DUPLICATE_MEMBER",
    )
}

struct Policy<'a> {
    input: &'a PoolWrite,
    cpus: Option<String>,
}
impl<'a> Policy<'a> {
    fn new(input: &'a PoolWrite) -> Result<Self> {
        need(
            input.common.anchor_start.is_some_and(|v| v > 0),
            "BOXED_RESOURCE_ANCHOR_BIRTH_REQUIRED",
        )?;
        need(
            input.memory_max > 0 && input.pids_max > 0 && (1..=10000).contains(&input.cpu_weight),
            "BOXED_RESOURCE_POLICY",
        )?;
        Ok(Self {
            input,
            cpus: input
                .cpuset_cpus
                .as_deref()
                .map(data::canonical_cpus)
                .transpose()?,
        })
    }
    fn require_final(&self, actual: &Resources) -> Result<()> {
        need(
            self.cpus
                .as_ref()
                .is_none_or(|cpus| actual.cpuset_cpus == *cpus),
            "BOXED_RESOURCE_FINAL_CPU_SET",
        )?;
        need(
            actual.memory_max == self.input.memory_max.to_string()
                && actual.swap_max == self.input.swap_max.to_string()
                && actual.pids_max == self.input.pids_max.to_string()
                && actual.memory_high == "max"
                && actual.cpu_weight == self.input.cpu_weight.to_string(),
            "BOXED_RESOURCE_FINAL_POLICY",
        )
    }
}

// Production supplies only an earned Scope plus its exact writable parent FD.
// The component test port exercises actual owned files; it cannot mint a Scope.
trait Pool {
    fn resources(&mut self) -> Result<Resources>;
    fn write(&mut self, name: &str, value: &str) -> Result<()>;
}
fn apply(pool: &mut impl Pool, policy: &Policy<'_>) -> Result<()> {
    let initial = pool.resources()?;
    if let Some(cpus) = &policy.cpus {
        let selected = data::cpus(cpus)?;
        let available = data::cpus(&initial.cpuset_cpus_effective)?;
        need(
            !selected.is_empty() && selected.is_subset(&available),
            "BOXED_RESOURCE_CPU_SET_UNAVAILABLE",
        )?;
        pool.write("cpuset.cpus", cpus)?;
    }
    for (name, value) in [
        ("memory.max", policy.input.memory_max.to_string()),
        ("memory.swap.max", policy.input.swap_max.to_string()),
        ("pids.max", policy.input.pids_max.to_string()),
        ("memory.high", "max".into()),
        ("cpu.weight", policy.input.cpu_weight.to_string()),
    ] {
        pool.write(name, &value)?;
    }
    policy.require_final(&pool.resources()?)
}
struct ScopedPool<'a> {
    files: &'a mut Files,
    scope: &'a Scope,
    index: usize,
    expected: (u64, u64),
}
impl Pool for ScopedPool<'_> {
    fn resources(&mut self) -> Result<Resources> {
        self.scope.assert_current(self.files)?;
        need(
            self.files.identity(self.index)? == self.expected,
            "BOXED_RESOURCE_PARENT_CHANGED",
        )?;
        let result = scope::resources(self.files, self.index)?;
        self.scope.assert_current(self.files)?;
        Ok(result)
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
pub(super) fn configure(files: &mut Files, input: &PoolWrite) -> Result<String> {
    let policy = Policy::new(input)?;
    let scope = Scope::capture(files, &input.common, None)?;
    let expected = (input.parent_dev, input.parent_ino);
    need(
        files.identity(scope.parent)? == expected,
        "BOXED_RESOURCE_PARENT_CHANGED",
    )?;
    let index = writable(files, &POOL, expected)?;
    apply(
        &mut ScopedPool {
            files,
            scope: &scope,
            index,
            expected,
        },
        &policy,
    )?;
    let result = observation(files, &scope, None)?;
    policy.require_final(&result.resources)?;
    if input.common.member.is_empty() {
        return encoded(&result);
    }
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct RestoreAck<'a> {
        version: u8,
        purpose: &'static str,
        observation: super::Observation<'a>,
        members: Vec<&'a scope::Identity>,
    }
    encoded(&RestoreAck {
        version: 1,
        purpose: "reverie-boxed-restore-pool-ack-v1",
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
