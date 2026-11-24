mod memory_high;
mod pool;
mod pool_cpu;

use crate::{
    args::{Common, HighWrite, MemoryHighWrite, PoolCpuMaxWrite, PoolWrite, Worker},
    data::Resources,
    error::{Result, need},
    files::Files,
    scope::{self, Identity, Scope},
};
use nix::sys::statfs::CGROUP2_SUPER_MAGIC;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Observation<'a> {
    version: u8,
    purpose: &'static str,
    box_id: &'a str,
    parent: Parent<'a>,
    anchor: &'a Identity,
    worker: Option<&'a Identity>,
    resources: Resources,
}
#[derive(Serialize)]
struct Parent<'a> {
    path: &'a str,
    dev: String,
    ino: String,
}
fn observation<'a>(
    files: &mut Files,
    scope: &'a Scope,
    worker: Option<&str>,
) -> Result<Observation<'a>> {
    let target = worker
        .map(|id| scope.worker(id))
        .transpose()?
        .unwrap_or(scope.parent);
    let resources = scope::resources(files, target)?;
    scope.assert_current(files)?;
    let (dev, ino) = files.identity(scope.parent)?;
    Ok(Observation {
        version: 1,
        purpose: "reverie-boxed-resource-observation-v1",
        box_id: &scope.common.box_id,
        parent: Parent {
            path: &scope.parent_path,
            dev: dev.to_string(),
            ino: ino.to_string(),
        },
        anchor: &scope.processes[0].identity,
        worker: worker.and_then(|id| {
            scope
                .processes
                .iter()
                .find(|p| p.identity.id == id)
                .map(|p| &p.identity)
        }),
        resources,
    })
}
fn encoded(value: &impl Serialize) -> Result<String> {
    serde_json::to_string(value)
        .map_err(std::io::Error::other)
        .map_err(Into::into)
}
pub(crate) fn probe_pool(files: &mut Files, common: &Common) -> Result<String> {
    let scope = Scope::capture(files, common, None)?;
    encoded(&observation(files, &scope, None)?)
}
fn worker_scope(files: &mut Files, worker: &Worker) -> Result<Scope> {
    let mut common = worker.common.clone();
    common.member.push(crate::args::Member {
        id: worker.worker_id.clone(),
        pid: worker.worker_pid,
        start: worker.worker_start.unwrap_or(0),
    });
    Scope::capture(files, &common, Some(&worker.worker_id))
}
pub(crate) fn probe_worker(files: &mut Files, worker: &Worker) -> Result<String> {
    let scope = worker_scope(files, worker)?;
    encoded(&observation(files, &scope, Some(&worker.worker_id))?)
}
/// The writable mount of the one cgroup an operation may change.
struct Writable {
    path: &'static str,
    /// Its name in failure reports.
    role: &'static str,
}
const LEAF: Writable = Writable {
    path: "/run/reverie-worker-cgroup",
    role: "leaf",
};
const POOL: Writable = Writable {
    path: "/run/reverie-box-pool",
    role: "pool",
};
fn writable(files: &mut Files, mount: &Writable, expected: (u64, u64)) -> Result<usize> {
    let index = files
        .root(mount.path, CGROUP2_SUPER_MAGIC, false)
        .map_err(|error| error.of(|| mount.role.to_owned()))?;
    files.name(index, mount.role);
    need(
        files.identity(index)? == expected,
        "BOXED_RESOURCE_WRITABLE_IDENTITY",
    )?;
    Ok(index)
}
fn write_checked(
    files: &mut Files,
    scope: &Scope,
    index: usize,
    expected: (u64, u64),
    name: &str,
    value: &str,
) -> Result<()> {
    scope.assert_current(files)?;
    need(
        files.identity(index)? == expected,
        "BOXED_RESOURCE_WRITABLE_IDENTITY",
    )?;
    files.write(index, name, &format!("{value}\n"))?;
    need(
        files.read(index, name, 4096)?.trim_end_matches('\n') == value,
        "BOXED_RESOURCE_WRITE_READBACK",
    )?;
    files.confirm(name);
    scope.assert_current(files)
}
pub(crate) fn configure_pool(files: &mut Files, input: &PoolWrite) -> Result<String> {
    need(
        input.common.member.is_empty(),
        "BOXED_RESOURCE_POOL_INITIALIZATION_ONLY",
    )?;
    pool::configure(files, input)
}
pub(crate) fn restore_pool(files: &mut Files, input: &PoolWrite) -> Result<String> {
    pool::require_restore_members(&input.common)?;
    need(
        input.cpuset_cpus.is_some(),
        "BOXED_RESOURCE_RESTORE_CPU_SET_REQUIRED",
    )?;
    pool::configure(files, input)
}
pub(crate) fn configure_pool_cpu_max(files: &mut Files, input: &PoolCpuMaxWrite) -> Result<String> {
    pool_cpu::configure(files, input)
}
fn require_hard(resources: &Resources, input: &HighWrite) -> Result<()> {
    need(
        resources.memory_max == input.memory_max.to_string()
            && resources.swap_max == input.swap_max.to_string()
            && resources.pids_max == input.pids_max.to_string(),
        "BOXED_RESOURCE_HARD_POLICY_MISMATCH",
    )
}
pub(crate) fn configure_high(files: &mut Files, input: &HighWrite) -> Result<String> {
    need(
        (1..=10000).contains(&input.cpu_weight),
        "BOXED_RESOURCE_CPU_WEIGHT",
    )?;
    need(
        input.worker.worker_start.is_some_and(|v| v > 0),
        "BOXED_RESOURCE_PID_BIRTH_REQUIRED",
    )?;
    need(
        input.worker.common.anchor_start.is_some_and(|v| v > 0),
        "BOXED_RESOURCE_ANCHOR_BIRTH_REQUIRED",
    )?;
    need(
        input.memory_high > 0 && input.memory_high <= input.memory_max && input.pids_max > 0,
        "BOXED_RESOURCE_POLICY",
    )?;
    let scope = worker_scope(files, &input.worker)?;
    let target = scope.worker(&input.worker.worker_id)?;
    let expected = (input.leaf_dev, input.leaf_ino);
    need(
        files.identity(target)? == expected,
        "BOXED_RESOURCE_LEAF_CHANGED",
    )?;
    let index = writable(files, &LEAF, expected)?;
    require_hard(&scope::resources(files, index)?, input)?;
    write_checked(
        files,
        &scope,
        index,
        expected,
        "memory.high",
        &input.memory_high.to_string(),
    )?;
    write_checked(
        files,
        &scope,
        index,
        expected,
        "cpu.weight",
        &input.cpu_weight.to_string(),
    )?;
    let result = observation(files, &scope, Some(&input.worker.worker_id))?;
    require_hard(&result.resources, input)?;
    need(
        result.resources.memory_high == input.memory_high.to_string()
            && result.resources.cpu_weight == input.cpu_weight.to_string(),
        "BOXED_RESOURCE_FINAL_POLICY",
    )?;
    encoded(&result)
}

pub(crate) fn configure_memory_high(files: &mut Files, input: &MemoryHighWrite) -> Result<String> {
    memory_high::configure(files, input)
}
