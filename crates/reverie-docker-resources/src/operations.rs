mod memory_high;

use crate::{
    args::{Common, HighWrite, MemoryHighWrite, PoolWrite, Worker},
    data::{self, Resources},
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
    let scope = Scope::capture(files, common)?;
    encoded(&observation(files, &scope, None)?)
}
fn worker_scope(files: &mut Files, worker: &Worker) -> Result<Scope> {
    let mut common = worker.common.clone();
    common.member.push(crate::args::Member {
        id: worker.worker_id.clone(),
        pid: worker.worker_pid,
        start: worker.worker_start.unwrap_or(0),
    });
    Scope::capture(files, &common)
}
pub(crate) fn probe_worker(files: &mut Files, worker: &Worker) -> Result<String> {
    let scope = worker_scope(files, worker)?;
    encoded(&observation(files, &scope, Some(&worker.worker_id))?)
}
fn writable(files: &mut Files, path: &str, expected: (u64, u64)) -> Result<usize> {
    let index = files.root(path, CGROUP2_SUPER_MAGIC, false)?;
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
    scope.assert_current(files)
}
pub(crate) fn configure_pool(files: &mut Files, input: &PoolWrite) -> Result<String> {
    let cpus = input
        .cpuset_cpus
        .as_deref()
        .map(data::canonical_cpus)
        .transpose()?;
    need(
        input.common.anchor_start.is_some_and(|v| v > 0),
        "BOXED_RESOURCE_ANCHOR_BIRTH_REQUIRED",
    )?;
    need(
        input.common.member.is_empty(),
        "BOXED_RESOURCE_POOL_INITIALIZATION_ONLY",
    )?;
    need(
        input.memory_max > 0 && input.pids_max > 0 && (1..=10000).contains(&input.cpu_weight),
        "BOXED_RESOURCE_POLICY",
    )?;
    let scope = Scope::capture(files, &input.common)?;
    let expected = (input.parent_dev, input.parent_ino);
    need(
        files.identity(scope.parent)? == expected,
        "BOXED_RESOURCE_PARENT_CHANGED",
    )?;
    let index = writable(files, "/run/reverie-box-pool", expected)?;
    if let Some(cpus) = &cpus {
        let selected = data::cpus(cpus)?;
        let available = data::cpus(&files.read(index, "cpuset.cpus.effective", 4096)?)?;
        need(
            !selected.is_empty() && selected.is_subset(&available),
            "BOXED_RESOURCE_CPU_SET_UNAVAILABLE",
        )?;
        write_checked(files, &scope, index, expected, "cpuset.cpus", cpus)?;
    }
    for (name, value) in [
        ("memory.max", input.memory_max.to_string()),
        ("memory.swap.max", input.swap_max.to_string()),
        ("pids.max", input.pids_max.to_string()),
        ("memory.high", "max".into()),
        ("cpu.weight", input.cpu_weight.to_string()),
    ] {
        write_checked(files, &scope, index, expected, name, &value)?;
    }
    let result = observation(files, &scope, None)?;
    need(
        cpus.as_ref()
            .is_none_or(|cpus| result.resources.cpuset_cpus == *cpus),
        "BOXED_RESOURCE_FINAL_CPU_SET",
    )?;
    need(
        result.resources.memory_max == input.memory_max.to_string()
            && result.resources.swap_max == input.swap_max.to_string()
            && result.resources.pids_max == input.pids_max.to_string()
            && result.resources.memory_high == "max"
            && result.resources.cpu_weight == input.cpu_weight.to_string(),
        "BOXED_RESOURCE_FINAL_POLICY",
    )?;
    encoded(&result)
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
    let index = writable(files, "/run/reverie-worker-cgroup", expected)?;
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
