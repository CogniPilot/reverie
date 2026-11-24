use crate::{
    args::decimal,
    error::{Result, need},
};
use serde::Serialize;
use std::collections::BTreeSet;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Resources {
    pub(crate) memory_max: String,
    pub(crate) memory_high: String,
    pub(crate) swap_max: String,
    pub(crate) pids_max: String,
    pub(crate) cpu_weight: String,
    pub(crate) cpu_max: String,
    pub(crate) cpuset_cpus: String,
    pub(crate) cpuset_cpus_effective: String,
    pub(crate) cpuset_mems_effective: String,
}
pub(crate) fn scalar(raw: &str) -> Result<String> {
    let value = raw.strip_suffix('\n').unwrap_or(raw);
    need(
        value == "max" || decimal(value).is_ok(),
        "BOXED_RESOURCE_SCALAR",
    )?;
    Ok(value.to_owned())
}
pub(crate) fn cpu_max(raw: &str) -> Result<String> {
    let raw = raw.strip_suffix('\n').unwrap_or(raw);
    let parts = raw.split(' ').collect::<Vec<_>>();
    need(parts.len() == 2, "BOXED_RESOURCE_CPU_MAX")?;
    need(
        parts[0] == "max" || decimal(parts[0]).is_ok_and(|value| value > 0),
        "BOXED_RESOURCE_CPU_QUOTA",
    )?;
    need(
        decimal(parts[1]).is_ok_and(|value| value > 0),
        "BOXED_RESOURCE_CPU_PERIOD",
    )?;
    Ok(raw.to_owned())
}
pub(crate) fn cpus(raw: &str) -> Result<BTreeSet<u32>> {
    let raw = raw.strip_suffix('\n').unwrap_or(raw);
    let mut output = BTreeSet::new();
    if raw.is_empty() {
        return Ok(output);
    }
    for group in raw.split(',') {
        let range = group.split('-').collect::<Vec<_>>();
        need((1..=2).contains(&range.len()), "BOXED_RESOURCE_CPU_SET")?;
        let first = decimal(range[0])
            .map_err(|_| crate::error::Error::Refused("BOXED_RESOURCE_CPU_SET"))?;
        let last = if range.len() == 2 {
            decimal(range[1]).map_err(|_| crate::error::Error::Refused("BOXED_RESOURCE_CPU_SET"))?
        } else {
            first
        };
        need(first <= last && last < 8192, "BOXED_RESOURCE_CPU_SET_BOUND")?;
        for value in first..=last {
            need(
                output.insert(value as u32),
                "BOXED_RESOURCE_CPU_SET_DUPLICATE",
            )?;
        }
    }
    Ok(output)
}
pub(crate) fn canonical_cpus(raw: &str) -> Result<String> {
    let values = cpus(raw)?.into_iter().collect::<Vec<_>>();
    let mut groups = Vec::new();
    let mut index = 0;
    while index < values.len() {
        let first = values[index];
        let mut last = first;
        index += 1;
        while index < values.len() && values[index] == last + 1 {
            last = values[index];
            index += 1;
        }
        groups.push(if first == last {
            first.to_string()
        } else {
            format!("{first}-{last}")
        });
    }
    Ok(groups.join(","))
}
/// Refusal for a well-formed stat record of a task that has already exited.
pub(crate) const PID_EXITED: &str = "BOXED_RESOURCE_PID_EXITED";
pub(crate) fn process_stat(raw: &str, pid: u32) -> Result<u64> {
    need(
        raw.starts_with(&format!("{pid} (")),
        "BOXED_RESOURCE_PID_STAT",
    )?;
    let end = raw
        .rfind(") ")
        .ok_or(crate::error::Error::Refused("BOXED_RESOURCE_PID_STAT"))?;
    let fields = raw[end + 2..].split_whitespace().collect::<Vec<_>>();
    // A truncated record says nothing about the task; only its state does.
    need(fields.len() >= 20, "BOXED_RESOURCE_PID_STAT")?;
    need(!matches!(fields[0], "Z" | "X" | "x"), PID_EXITED)?;
    decimal(fields[19])
        .ok()
        .filter(|value| *value > 0)
        .ok_or(crate::error::Error::Refused("BOXED_RESOURCE_PID_BIRTH"))
}
