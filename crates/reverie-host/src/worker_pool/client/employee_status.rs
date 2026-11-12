//! Read-only limits under the original installed controller custody.
//! Selected IDs identify observations and authorize no mutation.
use super::*;
use crate::website_facts::WebsiteProcessObserver;
use reverie_contracts::storage_identity::CurrentEmployee;
use reverie_core::ids::{ProfileEmployeeId, ProfileSessionId};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmployeeResourceObservation {
    pub container_id: String,
    pub pid: u32,
    pub process_start: String,
    pub leaf_device: String,
    pub leaf_inode: String,
    pub memory_high_bytes: String,
    pub memory_max_bytes: String,
    pub memory_current_bytes: String,
    pub memory_swap_max_bytes: String,
    pub cpu_weight: u32,
    pub cpu_max: String,
    pub allowed_cpus: Vec<u32>,
}
impl ActivatedController {
    pub fn observe_employee_resources(
        &mut self,
        runtime: &WorkerRuntime,
        query: &MetadataQueryOwner,
        processes: &mut WebsiteProcessObserver,
        current: &CurrentEmployee,
        container: &ContainerId,
        end: Instant,
    ) -> Result<EmployeeResourceObservation> {
        let owner = self.state_mut();
        let end = owner
            .binding
            .stop
            .deadline()
            .map_or(end, |stop| end.min(stop));
        query
            .assert_engine(&runtime.installed_engine().readonly())
            .map_err(PoolError::Engine)?;
        assert_current(owner, query, processes, runtime, end)?;
        let data = observe(
            owner,
            query,
            runtime,
            current.identity(),
            current.session(),
            container,
            end,
        )?;
        assert_current(owner, query, processes, runtime, end)?;
        Ok(data)
    }
}
pub(super) fn observe(
    owner: &mut ControllerState,
    query: &MetadataQueryOwner,
    runtime: &WorkerRuntime,
    employee: &ProfileEmployeeId,
    session: &ProfileSessionId,
    container: &ContainerId,
    end: Instant,
) -> Result<EmployeeResourceObservation> {
    check_end(owner, end)?;
    let raw = inspect(owner, query, runtime, container, end)?;
    let rows: Vec<serde_json::Value> = serde_json::from_str(&raw)
        .map_err(|_| PoolError::Refused("WORKER_POOL_EMPLOYEE_INSPECTION"))?;
    need(rows.len() == 1, "WORKER_POOL_EMPLOYEE_INSPECTION")?;
    let row = &rows[0];
    let pid = row["State"]["Pid"]
        .as_u64()
        .and_then(|value| u32::try_from(value).ok())
        .filter(|pid| *pid > 1)
        .ok_or(PoolError::Refused("WORKER_POOL_EMPLOYEE_PID"))?;
    need(
        row["Id"] == container.as_str()
            && row["Name"] == format!("/{}-agent-{session}", owner.policy.deployment)
            && row["State"]["Running"] == true
            && row["State"]["Paused"] == false
            && row["State"]["Restarting"] == false
            && row["Config"]["Labels"]["reverie.worker"] == owner.policy.deployment
            && row["Config"]["Labels"]["reverie.employee"] == employee.as_str()
            && row["Config"]["Labels"]["reverie.session"] == session.as_str()
            && row["HostConfig"]["CgroupParent"] == owner.policy.parent_slice(),
        "WORKER_POOL_EMPLOYEE_BINDING",
    )?;
    let group = format!(
        "0::/{}/docker-{}.scope\n",
        owner.policy.parent_cgroup_relative(),
        container.as_str()
    );
    let start = directory::process_start(pid)?;
    need(
        directory::bounded_path(&format!("/proc/{pid}/cgroup"), 4096)? == group,
        "WORKER_POOL_EMPLOYEE_MEMBERSHIP",
    )?;
    let file = native::open_at(
        owner.directory.parent()?.as_raw_fd(),
        std::ffi::OsStr::new(&format!("docker-{}.scope", container.as_str())),
        libc::O_RDONLY | libc::O_DIRECTORY,
    )?;
    let observed = read_limits(owner, &file, container, pid, &start, &group, end);
    let closed = native::close(file).map_err(PoolError::from);
    let data = finalized(observed, closed)?;
    let named = native::open_at(
        owner.directory.parent()?.as_raw_fd(),
        std::ffi::OsStr::new(&format!("docker-{}.scope", container.as_str())),
        libc::O_RDONLY | libc::O_DIRECTORY,
    )?;
    let same = directory::identity(&named).and_then(|identity| {
        need(
            identity.0.to_string() == data.leaf_device && identity.1.to_string() == data.leaf_inode,
            "WORKER_POOL_EMPLOYEE_LEAF_CHANGED",
        )
    });
    let closed = native::close(named).map_err(PoolError::from);
    finalized(same, closed)?;
    let current = inspect(owner, query, runtime, container, end)?;
    need(
        reverie_contracts::worker_recovery::RecoveryInspection::same_container_inspection(
            container, &raw, &current,
        )
        .map_err(|_| PoolError::Refused("WORKER_POOL_EMPLOYEE_INSPECTION"))?,
        "WORKER_POOL_EMPLOYEE_CHANGED",
    )?;
    check_end(owner, end)?;
    need(
        directory::process_start(pid)? == start
            && directory::bounded_path(&format!("/proc/{pid}/cgroup"), 4096)? == group,
        "WORKER_POOL_EMPLOYEE_CHANGED",
    )?;
    Ok(data)
}
fn read_limits(
    owner: &ControllerState,
    file: &File,
    container: &ContainerId,
    pid: u32,
    start: &str,
    group: &str,
    end: Instant,
) -> Result<EmployeeResourceObservation> {
    check_end(owner, end)?;
    let identity = directory::identity(file)?;
    let high = limit(file, "memory.high", true)?;
    let maximum = limit(file, "memory.max", true)?;
    let current = limit(file, "memory.current", false)?;
    let swap = limit(file, "memory.swap.max", true)?;
    let weight = limit(file, "cpu.weight", false)?
        .parse::<u32>()
        .map_err(|_| PoolError::Refused("WORKER_POOL_EMPLOYEE_WEIGHT"))?;
    need(
        (1..=10_000).contains(&weight),
        "WORKER_POOL_EMPLOYEE_WEIGHT",
    )?;
    let cpu_max = directory::read_at(file, "cpu.max")?.trim().to_owned();
    let parts: Vec<_> = cpu_max.split_whitespace().collect();
    need(
        parts.len() == 2
            && (parts[0] == "max" || parts[0].parse::<u64>().is_ok_and(|n| n > 0))
            && parts[1].parse::<u64>().is_ok_and(|n| n > 0),
        "WORKER_POOL_EMPLOYEE_CPU_MAX",
    )?;
    let cpus = directory::parse_cpus(directory::read_at(file, "cpuset.cpus.effective")?.trim())?;
    check_end(owner, end)?;
    need(
        directory::process_start(pid)? == start
            && directory::bounded_path(&format!("/proc/{pid}/cgroup"), 4096)? == group
            && directory::identity(file)? == identity,
        "WORKER_POOL_EMPLOYEE_CHANGED",
    )?;
    Ok(EmployeeResourceObservation {
        container_id: container.as_str().to_owned(),
        pid,
        process_start: start.to_owned(),
        leaf_device: identity.0.to_string(),
        leaf_inode: identity.1.to_string(),
        memory_high_bytes: high,
        memory_max_bytes: maximum,
        memory_current_bytes: current,
        memory_swap_max_bytes: swap,
        cpu_weight: weight,
        cpu_max,
        allowed_cpus: cpus,
    })
}
fn limit(file: &File, name: &str, unbounded: bool) -> Result<String> {
    let value = directory::read_at(file, name)?.trim().to_owned();
    need(
        (unbounded && value == "max")
            || (!value.is_empty()
                && value.bytes().all(|b| b.is_ascii_digit())
                && value.parse::<u64>().is_ok()),
        "WORKER_POOL_EMPLOYEE_LIMIT",
    )?;
    Ok(value)
}
fn inspect(
    owner: &mut ControllerState,
    query: &MetadataQueryOwner,
    runtime: &WorkerRuntime,
    id: &ContainerId,
    end: Instant,
) -> Result<String> {
    check_end(owner, end)?;
    query
        .query(
            EngineQuery::WorkerPoolInspect(id),
            end,
            &runtime.cancellation(),
        )
        .map_err(PoolError::Engine)
}
pub(super) fn assert_current(
    owner: &mut ControllerState,
    query: &MetadataQueryOwner,
    processes: &mut WebsiteProcessObserver,
    runtime: &WorkerRuntime,
    end: Instant,
) -> Result<()> {
    check_end(owner, end)?;
    owner.require_active()?;
    owner
        .binding
        .assert_current_with_process_observer(runtime, processes, end)?;
    owner.assert_controller_with_query(query, end)
}
fn check_end(owner: &ControllerState, end: Instant) -> Result<()> {
    need(
        Instant::now()
            < owner
                .binding
                .stop
                .deadline()
                .map_or(end, |stop| end.min(stop)),
        "WORKER_POOL_EMPLOYEE_DEADLINE",
    )
}
