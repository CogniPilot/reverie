use super::error::{Result, need};
use crate::native;
use std::path::Path;

#[derive(PartialEq)]
pub(super) struct KernelFacts {
    pub(super) paranoid: i32,
    pub(super) uid: u32,
}
pub(super) fn observe() -> Result<KernelFacts> {
    let status = native::read_reservation(Path::new("/proc/self/status"), 65_536)?;
    let status = std::str::from_utf8(&status)
        .map_err(|_| super::PerfCheckError::Refused("TASK_PERF_STATUS_ENCODING"))?;
    let uid = nix::unistd::geteuid().as_raw();
    need(
        uid > 0 && uid == nix::unistd::getuid().as_raw(),
        "TASK_PERF_ORDINARY_UID_REQUIRED",
    )?;
    for name in ["CapEff:", "CapPrm:"] {
        let values = status
            .lines()
            .filter_map(|line| line.strip_prefix(name))
            .collect::<Vec<_>>();
        need(
            values.len() == 1 && u64::from_str_radix(values[0].trim(), 16) == Ok(0),
            "TASK_PERF_CAPABILITIES_REFUSED",
        )?;
    }
    need(
        status.lines().filter(|line| *line == "Seccomp:\t2").count() == 1,
        "TASK_PERF_SECCOMP_REQUIRED",
    )?;
    let raw = native::read_reservation(Path::new("/proc/sys/kernel/perf_event_paranoid"), 64)?;
    let paranoid = std::str::from_utf8(&raw)
        .ok()
        .and_then(|raw| raw.trim().parse().ok())
        .ok_or(super::PerfCheckError::Refused(
            "TASK_PERF_KERNEL_FACTS_INVALID",
        ))?;
    Ok(KernelFacts { paranoid, uid })
}
