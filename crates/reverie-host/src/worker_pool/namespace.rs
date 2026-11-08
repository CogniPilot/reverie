//! The fixed controller needs real host PID/user visibility. A host cgroup
//! namespace by itself does not expose Docker's host PIDs through /proc.
use super::directory::bounded_path;
use super::*;

#[derive(Eq, PartialEq)]
pub(super) struct ControllerProcessObservation {
    pub(super) container: String,
    pub(super) pid: u32,
    pub(super) start: String,
}

pub(super) fn assert_controller_namespaces() -> Result<ControllerProcessObservation> {
    let pid = std::process::id();
    let own = bounded_path("/proc/self/stat", 65_536)?;
    let host = bounded_path("/run/reverie-host-proc/self/stat", 65_536)?;
    let prefix = format!("{pid} ");
    need(
        pid > 1 && own.starts_with(&prefix) && host.starts_with(&prefix),
        "WORKER_POOL_HOST_PID_NAMESPACE_REQUIRED",
    )?;
    let start = reverie_contracts::kernel_accounting::process_start(&own)
        .map_err(|_| PoolError::Refused("WORKER_POOL_CONTROLLER_START_UNKNOWN"))?;
    let host_start = reverie_contracts::kernel_accounting::process_start(&host)
        .map_err(|_| PoolError::Refused("WORKER_POOL_CONTROLLER_START_UNKNOWN"))?;
    need(start == host_start, "WORKER_POOL_HOST_PROC_SUBSTITUTED")?;
    let uid_map = bounded_path("/proc/self/uid_map", 4096)?;
    need(
        uid_map.split_whitespace().collect::<Vec<_>>() == ["0", "0", "4294967295"],
        "WORKER_POOL_HOST_USER_NAMESPACE_REQUIRED",
    )?;
    let group = bounded_path("/proc/self/cgroup", 4096)?;
    let container = group
        .trim()
        .strip_prefix("0::/system.slice/docker-")
        .and_then(|text| text.strip_suffix(".scope"))
        .filter(|text| reverie_contracts::worker_pool::hex_id(text))
        .ok_or(PoolError::Refused("WORKER_POOL_CONTROLLER_PLACEMENT"))?
        .to_owned();
    let status = bounded_path("/proc/self/status", 65_536)?;
    let field = |name: &str| {
        status
            .lines()
            .find_map(|line| line.strip_prefix(name))
            .map(str::trim)
    };
    need(
        field("CapEff:") == Some("0000000000000000") && field("NoNewPrivs:") == Some("1"),
        "WORKER_POOL_RESTRICTED_CONTROLLER_REQUIRED",
    )?;
    let host_proc = nix::sys::statvfs::statvfs("/run/reverie-host-proc")
        .map_err(|_| PoolError::Refused("WORKER_POOL_HOST_PROC_UNKNOWN"))?;
    need(
        host_proc
            .flags()
            .contains(nix::sys::statvfs::FsFlags::ST_RDONLY),
        "WORKER_POOL_HOST_PROC_READONLY_REQUIRED",
    )?;
    Ok(ControllerProcessObservation {
        container,
        pid,
        start,
    })
}
