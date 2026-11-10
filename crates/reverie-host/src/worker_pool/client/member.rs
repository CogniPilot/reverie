use super::*;
use crate::worker_laptop::CreatedPoolTarget;
use reverie_contracts::worker_pool::WorkerPoolMemberPolicy;
pub(crate) struct MemberObservation {
    pub(crate) pid: u32,
    pub(crate) start: String,
    pub(crate) leaf: (u64, u64),
    pub(crate) settings: WorkerPoolMemberPolicy,
    pub(crate) group: String,
}
impl ControllerState {
    pub(crate) fn configure_target(
        &mut self,
        runtime: &WorkerRuntime,
        target: &CreatedPoolTarget<'_>,
        end: Instant,
    ) -> Result<MemberObservation> {
        target.assert_runtime(runtime)?;
        self.assert_current(runtime, end)?;
        self.effect_unknown = true;
        let reply=self.exchange(serde_json::json!({"verb":"configureMember","requestId":fresh_id()?,"employee":target.employee().as_str(),"session":target.session().as_str(),"container":target.container().as_str()}),end)?;
        need(
            reply["known"] == true && reply["phase"] == "memberConfigured",
            "WORKER_POOL_MEMBER_UNCONFIRMED",
        )?;
        let result = self.observe_member(runtime, target, end)?;
        self.effect_unknown = false;
        self.assert_current(runtime, end)?;
        Ok(result)
    }
    fn observe_member(
        &mut self,
        runtime: &WorkerRuntime,
        target: &CreatedPoolTarget<'_>,
        end: Instant,
    ) -> Result<MemberObservation> {
        let raw = self
            .query
            .query(
                EngineQuery::WorkerPoolInspect(target.container()),
                end,
                &runtime.cancellation(),
            )
            .map_err(PoolError::Engine)?;
        let pid = self.inspected_member_pid(target, &raw)?;
        let group = self.policy.parent_cgroup_relative();
        let expected = format!("0::/{group}/docker-{}.scope\n", target.container().as_str());
        need(
            directory::bounded_path(&format!("/proc/{pid}/cgroup"), 4096)? == expected,
            "WORKER_POOL_MEMBER_MEMBERSHIP",
        )?;
        let start = directory::process_start(pid)?;
        let settings = self
            .member_policy_edit
            .effective(&self.policy, target.employee().as_str())?;
        let file = native::open_at(
            self.directory.parent()?.as_raw_fd(),
            std::ffi::OsStr::new(&format!("docker-{}.scope", target.container().as_str())),
            libc::O_RDONLY | libc::O_DIRECTORY,
        )?;
        let checked = (|| {
            let leaf = directory::identity(&file)?;
            for (name, wanted) in [
                (
                    "memory.max",
                    (u64::from(self.policy.memory_max_mi_b) * 1_048_576).to_string(),
                ),
                ("memory.high", settings.memory_high_bytes().to_string()),
                ("memory.swap.max", "0".into()),
                ("cpu.max", "max 100000".into()),
                ("cpu.weight", settings.cpu_weight().to_string()),
            ] {
                need(
                    directory::read_at(&file, name)?.trim() == wanted,
                    "WORKER_POOL_MEMBER_LIMIT_READBACK",
                )?;
            }
            for name in ["cpuset.cpus", "cpuset.cpus.effective"] {
                need(
                    directory::parse_cpus(directory::read_at(&file, name)?.trim())?
                        == self.policy.allowed_cpus,
                    "WORKER_POOL_MEMBER_CPU_PLACEMENT",
                )?;
            }
            need(
                directory::process_start(pid)? == start
                    && directory::bounded_path(&format!("/proc/{pid}/cgroup"), 4096)? == expected,
                "WORKER_POOL_MEMBER_CHANGED",
            )?;
            Ok(leaf)
        })();
        let closed = native::close(file).map_err(PoolError::from);
        self.close_unknown |= closed.is_err();
        let leaf = finalized(checked, closed)?;
        let current = self
            .query
            .query(
                EngineQuery::WorkerPoolInspect(target.container()),
                end,
                &runtime.cancellation(),
            )
            .map_err(PoolError::Engine)?;
        need(
            reverie_contracts::worker_recovery::RecoveryInspection::same_container_inspection(
                target.container(),
                &raw,
                &current,
            )
            .map_err(|_| PoolError::Refused("WORKER_POOL_MEMBER_INSPECTION"))?,
            "WORKER_POOL_MEMBER_CHANGED",
        )?;
        Ok(MemberObservation {
            pid,
            start,
            leaf,
            settings,
            group,
        })
    }
    fn inspected_member_pid(&self, target: &CreatedPoolTarget<'_>, raw: &str) -> Result<u32> {
        let rows: Vec<serde_json::Value> = serde_json::from_str(raw)
            .map_err(|_| PoolError::Refused("WORKER_POOL_MEMBER_INSPECTION"))?;
        need(rows.len() == 1, "WORKER_POOL_MEMBER_INSPECTION")?;
        let row = &rows[0];
        let pid = row["State"]["Pid"]
            .as_u64()
            .and_then(|p| u32::try_from(p).ok())
            .filter(|p| *p > 1)
            .ok_or(PoolError::Refused("WORKER_POOL_MEMBER_PID"))?;
        need(
            row["Id"] == target.container().as_str()
                && row["State"]["Running"] == true
                && row["Config"]["Labels"]["reverie.worker"] == self.policy.deployment
                && row["Config"]["Labels"]["reverie.employee"] == target.employee().as_str()
                && row["Config"]["Labels"]["reverie.session"] == target.session().as_str(),
            "WORKER_POOL_MEMBER_INSPECTION",
        )?;
        Ok(pid)
    }
}
