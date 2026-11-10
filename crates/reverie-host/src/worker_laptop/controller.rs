//! Real Created/start/connection boundary for native pool member effects.
use super::*;
use crate::worker_pool::{ActivatedController, PoolError};
use crate::worker_reports::WorkerLaunchConnection;
use reverie_contracts::worker_config::WorkerPolicyDigest;
use reverie_core::ids::{ContainerId, ProfileEmployeeId, ProfileSessionId};

mod creation;
pub use creation::PoolMemberCreation;
pub(super) use creation::{check_member, retain_outcome};

pub(crate) struct CreatedPoolTarget<'a> {
    record: &'a Record,
    employee: ProfileEmployeeId,
    container: ContainerId,
}
impl CreatedPoolTarget<'_> {
    pub(crate) fn employee(&self) -> &ProfileEmployeeId {
        &self.employee
    }
    pub(crate) fn container(&self) -> &ContainerId {
        &self.container
    }
    pub(crate) fn session(&self) -> &ProfileSessionId {
        self.record.resources().plan.session()
    }
    pub(crate) fn assert_runtime(
        &self,
        runtime: &WorkerRuntime,
    ) -> std::result::Result<(), PoolError> {
        if self.record.resources().plan.same_runtime(runtime) {
            Ok(())
        } else {
            Err(PoolError::Refused("WORKER_POOL_MEMBER_RUNTIME"))
        }
    }
}
#[must_use = "consume this actual completed controller member effect in the original memory phase"]
pub struct ControllerMemberConfigured {
    workflow: LaptopWorkflow,
    container: ContainerId,
    policy: WorkerPolicyDigest,
    process: u32,
    start: String,
    leaf: (u64, u64),
    high: u64,
    group: String,
}
impl ControllerMemberConfigured {
    pub(in crate::worker_laptop) fn assert_memory(
        &self,
        runtime: &WorkerRuntime,
        workflow: &LaptopWorkflow,
        connection: &WorkerLaunchConnection,
        digest: &WorkerPolicyDigest,
    ) -> Result<()> {
        runtime
            .laptop_workflows()
            .assert_worker_connection(runtime, workflow, connection)?;
        need(
            self.workflow.same_workflow(workflow) && self.policy == *digest,
            "WORKER_POOL_MEMORY_WORKFLOW",
        )?;
        let mut record = workflow
            .record
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_RETAINED"))?;
        need(
            record.creation.as_ref().and_then(|c| c.container.as_ref()) == Some(&self.container)
                && !record.unknown,
            "WORKER_POOL_MEMORY_CREATED",
        )?;
        let observed = (|| {
            let path = format!(
                "/sys/fs/cgroup/{}/docker-{}.scope",
                self.group,
                self.container.as_str()
            );
            let file = crate::native::open_at(
                libc::AT_FDCWD,
                std::path::Path::new(&path).as_os_str(),
                libc::O_RDONLY | libc::O_DIRECTORY,
            )
            .map_err(LaptopError::Io)?;
            let body = (|| {
                use std::os::unix::fs::MetadataExt;
                let m = file.metadata().map_err(LaptopError::Io)?;
                need(
                    (m.dev(), m.ino()) == self.leaf,
                    "WORKER_POOL_MEMORY_MEMBER_REBOUND",
                )?;
                let expected = format!(
                    "0::/{}/docker-{}.scope\n",
                    self.group,
                    self.container.as_str()
                );
                need(
                    crate::worker_pool::directory::bounded_path(
                        &format!("/proc/{}/cgroup", self.process),
                        4096,
                    )
                    .map_err(pool_error)?
                        == expected
                        && crate::worker_pool::directory::process_start(self.process)
                            .map_err(pool_error)?
                            == self.start,
                    "WORKER_POOL_MEMORY_PROCESS",
                )?;
                need(
                    crate::worker_pool::directory::read_at(&file, "memory.high")
                        .map_err(pool_error)?
                        .trim()
                        == self.high.to_string(),
                    "WORKER_POOL_MEMORY_READBACK",
                )
            })();
            finalized(
                body,
                crate::native::close(file).map_err(LaptopError::Observation),
            )
        })();
        if let Err(error) = observed {
            if error.unconfirmed_native() {
                let error = Arc::new(error);
                record.unknown = true;
                record.phase = Phase::Retained;
                record.outcome = Some(Err(error.clone()));
                return Err(LaptopError::Recorded(error));
            }
            return Err(error);
        }
        Ok(())
    }
}
pub(super) fn pool_error(error: PoolError) -> LaptopError {
    LaptopError::ControllerPool(error::ControllerPoolFailure::new(error))
}
impl ActivatedController {
    pub fn configure_created_member(
        &mut self,
        runtime: &WorkerRuntime,
        created: &CreatedLaptop,
        started: &StartedContainer,
        connection: &WorkerLaunchConnection,
        end: Instant,
    ) -> std::result::Result<ControllerMemberConfigured, PoolError> {
        runtime
            .laptop_workflows()
            .assert_worker_connection(runtime, &created.workflow, connection)
            .map_err(|_| PoolError::Refused("WORKER_POOL_CREATED_CONNECTION"))?;
        if !started.same_workflow(&created.workflow)
            || created.container_id() != started.container_id()
        {
            return Err(PoolError::Refused("WORKER_POOL_CREATED_START"));
        }
        let mut record = created
            .workflow
            .record
            .try_lock()
            .map_err(|_| PoolError::Refused("WORKER_POOL_CREATED_RETAINED"))?;
        if record.phase != Phase::Known
            || record.unknown
            || !record.creation.as_ref().is_some_and(|c| {
                c.stage == create::CreateStage::Started
                    && !c.controller_member_attempted
                    && c.container.as_ref() == created.container_id()
            })
        {
            return Err(PoolError::Refused("WORKER_POOL_CREATED_STAGE"));
        }
        let employee = record
            .resources()
            .plan
            .storage()
            .employee()
            .ok_or(PoolError::Refused("WORKER_POOL_EMPLOYEE_REQUIRED"))?
            .clone();
        let container = created
            .container_id()
            .ok_or(PoolError::Refused("WORKER_POOL_CREATED_CID"))?
            .clone();
        let policy = record.resources().plan.arguments().policy_digest().clone();
        record
            .creation
            .as_mut()
            .expect("actual Created")
            .controller_member_attempted = true;
        record.phase = Phase::Running;
        let target = CreatedPoolTarget {
            record: &record,
            employee,
            container: container.clone(),
        };
        let observed = self.configure_target(runtime, &target, end);
        match observed {
            Ok(native) => {
                record.phase = Phase::Known;
                Ok(ControllerMemberConfigured {
                    workflow: created.workflow.clone(),
                    container,
                    policy,
                    process: native.pid,
                    start: native.start,
                    leaf: native.leaf,
                    high: native.high,
                    group: native.group,
                })
            }
            Err(error) => {
                record.unknown = true;
                record.phase = Phase::Retained;
                Err(error)
            }
        }
    }
}
