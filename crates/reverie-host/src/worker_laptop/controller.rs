//! Real Created/start/connection boundary for native pool member effects.
use super::*;
use crate::worker_pool::{ActivatedController, PoolError};
use crate::worker_reports::WorkerLaunchConnection;
use reverie_contracts::worker_config::WorkerPolicyDigest;
use reverie_core::ids::{ContainerId, ProfileEmployeeId, ProfileSessionId};

mod creation;
#[cfg(test)]
mod tests;
pub use creation::PoolMemberCreation;
pub(super) use creation::{check_member, retain_outcome};

/// Private identity of one original Created configuration attempt. This binds
/// a native refusal to its locked record; no serialized value constructs it.
#[derive(Clone, Debug)]
pub(crate) struct MemberConfigurationAttempt(Arc<()>);
impl MemberConfigurationAttempt {
    fn new() -> Self {
        Self(Arc::new(()))
    }
    pub(crate) fn same(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

pub(crate) struct CreatedPoolTarget<'a> {
    record: &'a Record,
    employee: ProfileEmployeeId,
    container: ContainerId,
    attempt: MemberConfigurationAttempt,
}
impl CreatedPoolTarget<'_> {
    pub(crate) fn member_attempt(&self) -> MemberConfigurationAttempt {
        self.attempt.clone()
    }
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

impl Record {
    fn begin_controller_member_attempt(&mut self) -> MemberConfigurationAttempt {
        let attempt = MemberConfigurationAttempt::new();
        self.creation
            .as_mut()
            .expect("actual Created")
            .controller_member_attempt = Some(attempt.clone());
        self.phase = Phase::Running;
        attempt
    }
    fn reject_controller_member(
        &mut self,
        attempt: &MemberConfigurationAttempt,
        error: PoolError,
    ) -> PoolError {
        let known_refusal = matches!(&error,
            PoolError::MemberRequestRefused(refusal) if refusal.is_for_created(attempt));
        let original_known_attempt = self.phase == Phase::Running
            && !self.unknown
            && self.pending.is_none()
            && self.outcome.as_ref().is_some_and(|outcome| outcome.is_ok())
            && self.creation.as_ref().is_some_and(|creation| {
                creation.stage == create::CreateStage::Started
                    && creation
                        .controller_member_attempt
                        .as_ref()
                        .is_some_and(|original| original.same(attempt))
            });
        if known_refusal && original_known_attempt {
            let failure = Arc::new(pool_error(error));
            self.outcome = Some(Err(failure.clone()));
            self.phase = Phase::MemberRefused;
            return PoolError::Member(failure);
        }
        self.unknown = true;
        self.phase = Phase::Retained;
        if matches!(error, PoolError::MemberRequestRefused(_)) {
            // A real refusal for some other attempt cannot remain a known
            // request-local error when this Created owner is still unknown.
            return PoolError::Finalization(
                Box::new(error),
                Box::new(PoolError::Refused(
                    "WORKER_POOL_CREATED_REFUSAL_UNCONFIRMED",
                )),
            );
        }
        error
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
    settings: reverie_contracts::worker_pool::WorkerPoolMemberPolicy,
    group: String,
}
impl ControllerMemberConfigured {
    pub(in crate::worker_laptop) fn settings(
        &self,
    ) -> reverie_contracts::worker_pool::WorkerPoolMemberPolicy {
        self.settings
    }

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
            || record.pending.is_some()
            || !record
                .outcome
                .as_ref()
                .is_some_and(|outcome| outcome.is_ok())
            || !record.creation.as_ref().is_some_and(|c| {
                c.stage == create::CreateStage::Started
                    && c.controller_member_attempt.is_none()
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
        let provider = reverie_contracts::worker_pool::WorkerPoolProvider::from_config(
            record.resources().plan.source(),
        )
        .map_err(|_| PoolError::Refused("WORKER_POOL_PROVIDER_INVALID"))?
        .ok_or(PoolError::Refused("WORKER_POOL_CREATE_PROVIDER_CHANGED"))?;
        self.assert_member_policy_provider(&provider)?;
        self.assert_member_policy_unfenced()?;
        let container = created
            .container_id()
            .ok_or(PoolError::Refused("WORKER_POOL_CREATED_CID"))?
            .clone();
        let policy = record.resources().plan.arguments().policy_digest().clone();
        let attempt = record.begin_controller_member_attempt();
        let target = CreatedPoolTarget {
            record: &record,
            employee,
            container: container.clone(),
            attempt: attempt.clone(),
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
                    high: native.settings.memory_high_bytes(),
                    settings: native.settings,
                    group: native.group,
                })
            }
            Err(error) => Err(record.reject_controller_member(&attempt, error)),
        }
    }
}
