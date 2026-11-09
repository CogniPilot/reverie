//! Read only the retained controller's OWN fixed system-slice scope. This is
//! its bounded outside contribution, never aggregate host headroom or a grant.
use super::{
    directory::{parse_cpus, read_at},
    namespace, *,
};
use crate::native;
use reverie_contracts::worker_pool::{CONTROLLER_MEMORY_BYTES, CONTROLLER_TASKS_MAX};
use std::{ffi::OsStr, fs::File, os::unix::fs::MetadataExt};

pub(super) fn observe(
    original: &namespace::ControllerProcessObservation,
    policy: &WorkerPoolPolicy,
) -> Result<()> {
    need(
        namespace::assert_controller_namespaces()? == *original,
        "WORKER_POOL_CONTROLLER_CHANGED",
    )?;
    let path = format!(
        "/sys/fs/cgroup/system.slice/docker-{}.scope",
        original.container
    );
    let directory = open_scope(&path)?;
    let result = (|| {
        let observed = identity(&directory)?;
        let filesystem = nix::sys::statfs::fstatfs(&directory)
            .map_err(|_| PoolError::Refused("WORKER_POOL_CONTROLLER_FILESYSTEM_UNKNOWN"))?;
        need(
            filesystem.filesystem_type() == nix::sys::statfs::CGROUP2_SUPER_MAGIC,
            "WORKER_POOL_CONTROLLER_CGROUP2_REQUIRED",
        )?;
        for (name, expected) in [
            ("memory.max", CONTROLLER_MEMORY_BYTES.to_string()),
            ("memory.swap.max", "0".into()),
            ("pids.max", CONTROLLER_TASKS_MAX.to_string()),
            ("cpu.max", "max 100000".into()),
        ] {
            need(
                read_at(&directory, name)?.trim() == expected,
                "WORKER_POOL_CONTROLLER_LIMIT_READBACK",
            )?;
        }
        for name in ["cpuset.cpus", "cpuset.cpus.effective"] {
            need(
                parse_cpus(read_at(&directory, name)?.trim())? == policy.allowed_cpus,
                "WORKER_POOL_CONTROLLER_CPU_PLACEMENT",
            )?;
        }
        need(
            read_at(&directory, "cgroup.procs")?.trim() == original.pid.to_string(),
            "WORKER_POOL_CONTROLLER_PROCESS_MEMBERSHIP",
        )?;
        need(
            namespace::assert_controller_namespaces()? == *original,
            "WORKER_POOL_CONTROLLER_CHANGED",
        )?;
        let named = open_scope(&path)?;
        let current = (|| {
            need(
                identity(&named)? == observed && identity(&directory)? == observed,
                "WORKER_POOL_CONTROLLER_SCOPE_REBOUND",
            )
        })();
        finalized(current, native::close(named).map_err(Into::into))
    })();
    finalized(result, native::close(directory).map_err(Into::into))
}
fn open_scope(path: &str) -> Result<File> {
    Ok(native::open_at(
        nix::libc::AT_FDCWD,
        OsStr::new(path),
        nix::libc::O_RDONLY | nix::libc::O_DIRECTORY,
    )?)
}
fn identity(directory: &File) -> Result<(u64, u64)> {
    let metadata = directory.metadata()?;
    need(
        metadata.is_dir() && metadata.uid() == 0,
        "WORKER_POOL_CONTROLLER_SCOPE_OWNER",
    )?;
    Ok((metadata.dev(), metadata.ino()))
}
