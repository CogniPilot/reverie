use super::*;
use reverie_contracts::worker_pool::{CONTROLLER_MEMORY_BYTES, CONTROLLER_TASKS_MAX};

pub(super) fn observe(owner: &ControllerState, end: Instant) -> Result<()> {
    check_end(owner, end)?;
    let row = owner.inspect_original_controller(end)?;
    owner.verify_peer(&row)?;
    let id = owner
        .controller
        .as_ref()
        .ok_or(PoolError::Refused("WORKER_POOL_CONTROLLER_UNKNOWN"))?;
    let pid = row["State"]["Pid"]
        .as_u64()
        .and_then(|pid| u32::try_from(pid).ok())
        .ok_or(PoolError::Refused("WORKER_POOL_CONTROLLER_PID"))?;
    let start = directory::process_start(pid)?;
    let group = format!("system.slice/docker-{}.scope", id.as_str());
    let file = native::open_at(
        libc::AT_FDCWD,
        std::path::Path::new(&format!("/sys/fs/cgroup/{group}")).as_os_str(),
        libc::O_RDONLY | libc::O_DIRECTORY,
    )?;
    let body = (|| {
        let original = directory::identity(&file)?;
        let filesystem = nix::sys::statfs::fstatfs(&file).map_err(std::io::Error::from)?;
        need(
            filesystem.filesystem_type() == nix::sys::statfs::CGROUP2_SUPER_MAGIC,
            "WORKER_POOL_CONTROLLER_CGROUP2_REQUIRED",
        )?;
        limits(&file, &owner.policy)?;
        need(
            directory::read_at(&file, "cgroup.procs")?.trim() == pid.to_string()
                && directory::bounded_path(&format!("/proc/{pid}/cgroup"), 4096)?
                    == format!("0::/{group}\n")
                && directory::process_start(pid)? == start,
            "WORKER_POOL_CONTROLLER_PROCESS_MEMBERSHIP",
        )?;
        let named = native::open_at(
            libc::AT_FDCWD,
            std::path::Path::new(&format!("/sys/fs/cgroup/{group}")).as_os_str(),
            libc::O_RDONLY | libc::O_DIRECTORY,
        )?;
        let named_result = (|| {
            need(
                directory::identity(&named)? == original && directory::identity(&file)? == original,
                "WORKER_POOL_CONTROLLER_SCOPE_REBOUND",
            )
        })();
        finalized(named_result, native::close(named).map_err(Into::into))?;
        owner.verify_peer(&owner.inspect_original_controller(end)?)?;
        limits(&file, &owner.policy)?;
        need(
            directory::process_start(pid)? == start
                && directory::bounded_path(&format!("/proc/{pid}/cgroup"), 4096)?
                    == format!("0::/{group}\n"),
            "WORKER_POOL_CONTROLLER_PROCESS_MEMBERSHIP",
        )?;
        check_end(owner, end)
    })();
    finalized(body, native::close(file).map_err(Into::into))
}
fn limits(file: &File, policy: &WorkerPoolPolicy) -> Result<()> {
    for (name, expected) in [
        ("memory.max", CONTROLLER_MEMORY_BYTES.to_string()),
        ("memory.swap.max", "0".into()),
        ("pids.max", CONTROLLER_TASKS_MAX.to_string()),
        ("cpu.max", "max 100000".into()),
    ] {
        need(
            directory::read_at(file, name)?.trim() == expected,
            "WORKER_POOL_CONTROLLER_LIMIT_READBACK",
        )?;
    }
    for name in ["cpuset.cpus", "cpuset.cpus.effective"] {
        need(
            directory::parse_cpus(directory::read_at(file, name)?.trim())? == policy.allowed_cpus,
            "WORKER_POOL_CONTROLLER_CPU_PLACEMENT",
        )?;
    }
    Ok(())
}
