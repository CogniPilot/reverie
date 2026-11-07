//! The fixed controller needs real host PID/user visibility. A host cgroup
//! namespace by itself does not expose Docker's host PIDs through /proc.
use super::*;
use std::{fs, os::unix::fs::MetadataExt};

pub(super) fn assert_controller_namespaces() -> Result<()> {
    for name in ["pid", "user", "cgroup"] {
        let own = fs::metadata(format!("/proc/self/ns/{name}"))?;
        let host = fs::metadata(format!("/run/reverie-host-proc/1/ns/{name}"))?;
        need(
            (own.dev(), own.ino()) == (host.dev(), host.ino()),
            "WORKER_POOL_HOST_NAMESPACE_REQUIRED",
        )?;
    }
    let status = fs::read_to_string("/proc/self/status")?;
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
    )
}
