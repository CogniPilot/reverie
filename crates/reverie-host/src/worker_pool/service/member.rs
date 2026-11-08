use super::*;
impl State {
    pub(super) fn member(
        &mut self,
        policy: &ControllerPoolPolicy,
        employee: &str,
        session: &str,
        container: &str,
        configure: bool,
        end: Instant,
    ) -> Result<()> {
        check(end)?;
        need(self.member_failure.is_none(), "WORKER_POOL_MEMBER_RETAINED")?;
        if configure {
            need(
                self.member_attempted.len() < 256
                    && !self.member_attempted.iter().any(|id| id == container),
                "WORKER_POOL_MEMBER_ALREADY_ATTEMPTED",
            )?;
            self.member_attempted.push(container.to_owned());
        }
        let raw = policy.engine.inspect(container)?;
        let value: serde_json::Value = serde_json::from_slice(&raw)
            .map_err(|_| PoolError::Refused("WORKER_POOL_MEMBER_INSPECTION"))?;
        let data = policy.data();
        let pid = value["State"]["Pid"]
            .as_u64()
            .and_then(|pid| u32::try_from(pid).ok())
            .filter(|pid| *pid > 1)
            .ok_or(PoolError::Refused("WORKER_POOL_MEMBER_PID"))?;
        need(
            value["Id"] == container
                && value["Name"] == format!("/{}-agent-{session}", data.deployment)
                && value["State"]["Running"] == true
                && value["State"]["Paused"] == false
                && value["State"]["Restarting"] == false
                && value["Config"]["Labels"]["reverie.worker"] == data.deployment
                && value["Config"]["Labels"]["reverie.employee"] == employee
                && value["Config"]["Labels"]["reverie.session"] == session
                && value["HostConfig"]["CgroupParent"] == data.parent_slice()
                && value["HostConfig"]["Memory"] == u64::from(data.memory_max_mi_b) * 1_048_576
                && value["HostConfig"]["MemorySwap"] == u64::from(data.memory_max_mi_b) * 1_048_576,
            "WORKER_POOL_MEMBER_INSPECTION",
        )?;
        let tasks = value["HostConfig"]["PidsLimit"]
            .as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .ok_or(PoolError::Refused("WORKER_POOL_MEMBER_TASKS"))?;
        let limits = PoolMemberLimits::try_new(data.cpu_weight, tasks)?;
        let pool = self.installed(policy)?;
        check(end)?;
        let member = if configure {
            OpenedPoolMember::configure_new(&pool, employee, container, pid, limits, end)
        } else {
            OpenedPoolMember::capture(&pool, employee, container, pid, limits)
        };
        match member {
            Err(owner) => {
                self.member_failure = Some(owner.into_component());
                return Err(PoolError::Refused("WORKER_POOL_MEMBER_RETAINED"));
            }
            Ok(mut owner) => {
                let unchanged = policy
                    .engine
                    .inspect(container)
                    .and_then(|current| need(current == raw, "WORKER_POOL_MEMBER_CHANGED"));
                let closed = owner.close();
                if let Err(primary) = finalized(unchanged, closed) {
                    self.member_failure = Some(owner.into_component(primary));
                    return Err(PoolError::Refused("WORKER_POOL_MEMBER_RETAINED"));
                }
            }
        }
        check(end)
    }
}
