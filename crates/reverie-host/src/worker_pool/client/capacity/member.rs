use super::*;
use reverie_contracts::worker_pool::WorkerPoolMemberPolicy;
use std::ffi::OsStr;

pub(super) fn observe(
    owner: &mut ControllerState,
    row: &ContainerRow,
    binding: &NativeLimitBinding,
    end: Instant,
) -> Result<bool> {
    let raw = owner
        .query
        .query(
            EngineQuery::WorkerPoolInspect(row.id()),
            end,
            &owner.binding.engine.cancellation(),
        )
        .map_err(PoolError::Engine)?;
    let Ok(values) = serde_json::from_str::<Vec<serde_json::Value>>(&raw) else {
        return Ok(false);
    };
    if values.len() != 1 {
        return Ok(false);
    }
    let value = &values[0];
    let Ok((pid, effective, tasks)) = identity(owner, row, binding, value) else {
        // Unproved DATA earns no discount. The caller retains the already
        // native-verified full hard binding, not a guessed membership credit.
        return Ok(false);
    };
    let start = directory::process_start(pid)?;
    need(
        binding
            .start_matches(&start)
            .map_err(|_| PoolError::Refused("WORKER_POOL_CAPACITY_MEMBER_CHANGED"))?,
        "WORKER_POOL_CAPACITY_MEMBER_CHANGED",
    )?;
    let scope = format!("docker-{}.scope", row.id().as_str());
    let group = owner.policy.parent_cgroup_relative();
    let expected = format!("0::/{group}/{scope}\n");
    need(
        directory::bounded_path(&format!("/proc/{pid}/cgroup"), 4096)? == expected,
        "WORKER_POOL_CAPACITY_MEMBER_MEMBERSHIP",
    )?;
    let file = native::open_at(
        owner.directory.parent()?.as_raw_fd(),
        OsStr::new(&scope),
        libc::O_RDONLY | libc::O_DIRECTORY,
    )?;
    let body = (|| {
        let original = directory::identity(&file)?;
        limits(owner, &file, effective, tasks)?;
        process_current(pid, &start, &expected)?;
        let current = owner
            .query
            .query(
                EngineQuery::WorkerPoolInspect(row.id()),
                end,
                &owner.binding.engine.cancellation(),
            )
            .map_err(PoolError::Engine)?;
        need(
            reverie_contracts::worker_recovery::RecoveryInspection::same_container_inspection(
                row.id(),
                &raw,
                &current,
            )
            .map_err(|_| PoolError::Refused("WORKER_POOL_CAPACITY_MEMBER_CHANGED"))?,
            "WORKER_POOL_CAPACITY_MEMBER_CHANGED",
        )?;
        observe_parent(owner, end)?;
        limits(owner, &file, effective, tasks)?;
        process_current(pid, &start, &expected)?;
        let named = native::open_at(
            owner.directory.parent()?.as_raw_fd(),
            OsStr::new(&scope),
            libc::O_RDONLY | libc::O_DIRECTORY,
        )?;
        let named_result = (|| {
            need(
                directory::identity(&named)? == original && directory::identity(&file)? == original,
                "WORKER_POOL_CAPACITY_MEMBER_REBOUND",
            )
        })();
        finalized(named_result, native::close(named).map_err(Into::into))?;
        process_current(pid, &start, &expected)?;
        check_end(owner, end)?;
        Ok(true)
    })();
    finalized(body, native::close(file).map_err(Into::into))
}
fn process_current(pid: u32, start: &str, expected: &str) -> Result<()> {
    need(
        directory::process_start(pid)? == start
            && directory::bounded_path(&format!("/proc/{pid}/cgroup"), 4096)? == expected,
        "WORKER_POOL_CAPACITY_MEMBER_CHANGED",
    )
}
fn identity(
    owner: &ControllerState,
    row: &ContainerRow,
    binding: &NativeLimitBinding,
    value: &serde_json::Value,
) -> Result<(u32, WorkerPoolMemberPolicy, u32)> {
    let labels = &value["Config"]["Labels"];
    let employee = labels["reverie.employee"]
        .as_str()
        .ok_or(PoolError::Refused("WORKER_POOL_CAPACITY_MEMBER_LABELS"))?;
    let session = labels["reverie.session"]
        .as_str()
        .ok_or(PoolError::Refused("WORKER_POOL_CAPACITY_MEMBER_LABELS"))?;
    let pid = value["State"]["Pid"]
        .as_u64()
        .and_then(|pid| u32::try_from(pid).ok())
        .filter(|pid| *pid > 1)
        .ok_or(PoolError::Refused("WORKER_POOL_CAPACITY_MEMBER_PID"))?;
    let maximum = UnsignedInteger::from_u64(u64::from(owner.policy.memory_max_mi_b) * 1_048_576);
    let declared = row
        .declarations(&UnsignedInteger::from_u64(0))
        .map_err(|_| PoolError::Refused("WORKER_POOL_CAPACITY_MEMBER_LIMITS"))?;
    need(
        value["Id"] == row.id().as_str()
            && value["Name"] == format!("/{}-agent-{session}", owner.policy.deployment)
            && value["State"]["Running"] == true
            && value["State"]["Paused"] == false
            && value["State"]["Restarting"] == false
            && value["State"]["Dead"] == false
            && labels["reverie.worker"] == owner.policy.deployment
            && row
                .label_is("reverie.employee", employee)
                .map_err(|_| PoolError::Refused("WORKER_POOL_CAPACITY_MEMBER_LABELS"))?
            && row
                .label_is("reverie.session", session)
                .map_err(|_| PoolError::Refused("WORKER_POOL_CAPACITY_MEMBER_LABELS"))?
            && value["Image"]
                == row
                    .image()
                    .map_err(|_| PoolError::Refused("WORKER_POOL_CAPACITY_MEMBER_IMAGE"))?
            && binding
                .pid()
                .map_err(|_| PoolError::Refused("WORKER_POOL_CAPACITY_MEMBER_PID"))?
                == UnsignedInteger::from_u64(u64::from(pid))
            && binding.memory() == &maximum
            && value["HostConfig"]["CgroupParent"] == owner.policy.parent_slice()
            && value["HostConfig"]["Memory"].as_u64() == maximum.to_u64()
            && value["HostConfig"]["MemorySwap"].as_u64() == maximum.to_u64()
            && value["HostConfig"]["PidsLimit"].as_u64() == declared.tasks().to_u64()
            && value["HostConfig"]["NanoCpus"] == 0
            && value["HostConfig"]["CpuQuota"] == 0,
        "WORKER_POOL_CAPACITY_MEMBER_INSPECTION",
    )?;
    let effective = owner
        .member_policy_edit
        .effective(&owner.policy, employee)?;
    let tasks = declared
        .tasks()
        .to_u64()
        .and_then(|tasks| u32::try_from(tasks).ok())
        .ok_or(PoolError::Refused("WORKER_POOL_CAPACITY_MEMBER_TASKS"))?;
    PoolMemberLimits::try_new(effective.cpu_weight(), tasks)?;
    Ok((pid, effective, tasks))
}
fn limits(
    owner: &ControllerState,
    file: &File,
    effective: WorkerPoolMemberPolicy,
    tasks: u32,
) -> Result<()> {
    for (name, expected) in [
        (
            "memory.max",
            (u64::from(owner.policy.memory_max_mi_b) * 1_048_576).to_string(),
        ),
        ("memory.high", effective.memory_high_bytes().to_string()),
        ("memory.swap.max", "0".into()),
        ("pids.max", tasks.to_string()),
        ("cpu.max", "max 100000".into()),
        ("cpu.weight", effective.cpu_weight().to_string()),
    ] {
        need(
            directory::read_at(file, name)?.trim() == expected,
            "WORKER_POOL_CAPACITY_MEMBER_LIMIT_READBACK",
        )?;
    }
    for name in ["cpuset.cpus", "cpuset.cpus.effective"] {
        need(
            directory::parse_cpus(directory::read_at(file, name)?.trim())?
                == owner.policy.allowed_cpus,
            "WORKER_POOL_CAPACITY_MEMBER_CPU_PLACEMENT",
        )?;
    }
    for name in ["cpuset.mems", "cpuset.mems.effective"] {
        need(
            directory::parse_cpus(directory::read_at(file, name)?.trim())?
                == owner.directory.memory_nodes(),
            "WORKER_POOL_CAPACITY_MEMBER_MEMORY_PLACEMENT",
        )?;
    }
    Ok(())
}
