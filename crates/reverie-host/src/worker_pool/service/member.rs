use super::*;
use crate::worker_pool::member::MemberProcess;
use reverie_contracts::worker_pool::WorkerPoolMemberPolicy;

pub(super) struct InspectedMember {
    raw: Vec<u8>,
    pub(super) pid: u32,
    pub(super) limits: PoolMemberLimits,
}

impl State {
    /// Pure request validation precedes both attempted-CID admission and every
    /// native observation. A refused request does not consume a lifetime slot.
    fn prepare_member(
        &self,
        policy: &WorkerPoolPolicy,
        employee: &str,
        container: &str,
        configure: bool,
        end: Instant,
    ) -> std::result::Result<WorkerPoolMemberPolicy, MemberRequestRefusal> {
        if Instant::now() >= end {
            return Err(MemberRequestRefusal::deadline());
        }
        if configure {
            if self.member_attempted.iter().any(|id| id == container) {
                return Err(MemberRequestRefusal::already_attempted());
            }
            if self.member_attempted.len() >= 256 {
                return Err(MemberRequestRefusal::capacity());
            }
        }
        self.member_policies
            .effective(policy, employee)
            .map_err(|_| MemberRequestRefusal::policy())
    }

    pub(super) fn member(
        &mut self,
        policy: &ControllerPoolPolicy,
        employee: &str,
        session: &str,
        container: &str,
        configure: bool,
        end: Instant,
    ) -> Result<()> {
        need(self.member_failure.is_none(), "WORKER_POOL_MEMBER_RETAINED")?;
        let effective = self
            .prepare_member(policy.data(), employee, container, configure, end)
            .map_err(PoolError::MemberRequestRefused)?;
        if configure {
            self.member_attempted.push(container.to_owned());
        }
        let inspected = InspectedMember::capture(policy, employee, session, container, effective)?;
        let failure = {
            let pool = self.installed_member_pool(policy)?;
            pool.reobserve()?;
            check(end)?;
            let member = if configure {
                OpenedPoolMember::configure_new(
                    &pool,
                    container,
                    inspected.pid,
                    inspected.limits,
                    effective.memory_high_bytes(),
                    end,
                )
            } else {
                OpenedPoolMember::capture_with_policy(
                    &pool,
                    container,
                    inspected.pid,
                    inspected.limits,
                    Ok(effective.memory_high_bytes()),
                    MemberProcess::Starting,
                )
            };
            match member {
                Err(owner) => Some((*owner).into_component()),
                Ok(mut owner) => {
                    let unchanged = inspected.assert_current(policy, container);
                    let closed = owner.close();
                    finalized(unchanged, closed)
                        .err()
                        .map(|primary| owner.into_component(primary))
                }
            }
        };
        if let Some(failure) = failure {
            self.member_failure = Some(failure);
            return Err(PoolError::Refused("WORKER_POOL_MEMBER_RETAINED"));
        }
        check(end)
    }

    pub(super) fn installed_member_pool<'a>(
        &'a self,
        policy: &'a ControllerPoolPolicy,
    ) -> Result<InstalledWorkerPool<'a>> {
        need(
            self.stage == InstallationStage::Confirmed,
            "WORKER_POOL_INSTALLATION_UNKNOWN",
        )?;
        Ok(InstalledWorkerPool {
            policy,
            directory: self.directory()?,
            anchor_id: self
                .anchor
                .id
                .as_deref()
                .ok_or(PoolError::Refused("WORKER_POOL_ANCHOR_UNKNOWN"))?,
            anchor_pid: self.anchor.pid,
            stage: &self.stage,
        })
    }
}

#[cfg(test)]
mod tests;

impl InspectedMember {
    pub(super) fn capture(
        policy: &ControllerPoolPolicy,
        employee: &str,
        session: &str,
        container: &str,
        effective: WorkerPoolMemberPolicy,
    ) -> Result<Self> {
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
        let limits = PoolMemberLimits::try_new(effective.cpu_weight(), tasks)?;
        Ok(Self { raw, pid, limits })
    }

    pub(super) fn assert_current(
        &self,
        policy: &ControllerPoolPolicy,
        container: &str,
    ) -> Result<()> {
        let current = policy.engine.inspect(container)?;
        let same = reverie_contracts::worker_recovery::RecoveryInspection::same_container_object_inspection(
            container, &self.raw, &current,
        )
        .map_err(|_| PoolError::Refused("WORKER_POOL_MEMBER_INSPECTION"))?;
        need(same, "WORKER_POOL_MEMBER_CHANGED")
    }
}
