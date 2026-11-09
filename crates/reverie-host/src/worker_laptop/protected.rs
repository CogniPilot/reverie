//! Actual L-bound native phase observations. These are neither Q authority,
//! protected admission, fresh kernel readback nor durable capacity release.
use super::*;
use crate::worker_reports::WorkerLaunchConnection;
use reverie_contracts::worker_config::{WorkerConfigDigest, WorkerPolicyDigest};
use reverie_core::ids::{ContainerId, ProfileSessionId};
use std::sync::MutexGuard;

pub struct ProtectedCreatedObservation {
    workflow: LaptopWorkflow,
    target: ProfileSessionId,
    container: ContainerId,
    config: WorkerConfigDigest,
    policy: WorkerPolicyDigest,
}
pub struct ProtectedCliObservation {
    created: ProtectedCreatedObservation,
}
pub struct ProtectedMemoryObservation {
    created: ProtectedCreatedObservation,
}
impl ProtectedMemoryObservation {
    pub fn same_created(&self, created: &ProtectedCreatedObservation) -> bool {
        self.created.same_facts(created)
    }
    pub fn created(&self) -> &ProtectedCreatedObservation {
        &self.created
    }
    pub fn assert_current(
        &self,
        runtime: &WorkerRuntime,
        connection: &WorkerLaunchConnection,
    ) -> Result<()> {
        let record = checked_record(runtime, &self.created.workflow, connection)?;
        need(
            record
                .creation
                .as_ref()
                .is_some_and(|creation| creation.stage == create::CreateStage::MemoryConfigured)
                && self
                    .created
                    .same_facts(&observation(&self.created.workflow, &record)?),
            "RESOURCE_NATIVE_MEMORY_OBSERVATION_CHANGED",
        )
    }
}
impl ProtectedCreatedObservation {
    pub fn target_session(&self) -> &ProfileSessionId {
        &self.target
    }
    pub fn container_id(&self) -> &ContainerId {
        &self.container
    }
    pub fn config_digest(&self) -> &WorkerConfigDigest {
        &self.config
    }
    pub fn policy_digest(&self) -> &WorkerPolicyDigest {
        &self.policy
    }
    pub fn same_created(&self, created: &CreatedLaptop) -> bool {
        self.workflow.same_workflow(&created.workflow)
    }
    pub fn assert_current(
        &self,
        runtime: &WorkerRuntime,
        connection: &WorkerLaunchConnection,
    ) -> Result<()> {
        let record = checked_record(runtime, &self.workflow, connection)?;
        need(
            self.same_facts(&observation(&self.workflow, &record)?),
            "RESOURCE_NATIVE_CREATED_OBSERVATION_CHANGED",
        )
    }
    fn same_facts(&self, other: &Self) -> bool {
        self.workflow.same_workflow(&other.workflow)
            && self.container == other.container
            && self.target == other.target
            && self.config == other.config
            && self.policy == other.policy
    }
}
impl ProtectedCliObservation {
    /// Identity only. The caller still owns actual admission/canonical release;
    /// neither this comparison nor the local guard token releases capacity.
    pub fn same_released(&self, released: &NixReleasedPane) -> bool {
        self.created.workflow.same_workflow(&released.workflow)
    }
    pub fn same_created(&self, created: &ProtectedCreatedObservation) -> bool {
        self.created.same_facts(created)
    }
    pub fn created(&self) -> &ProtectedCreatedObservation {
        &self.created
    }
    pub fn assert_current(
        &self,
        runtime: &WorkerRuntime,
        connection: &WorkerLaunchConnection,
    ) -> Result<()> {
        let record = checked_record(runtime, &self.created.workflow, connection)?;
        need(
            cli_stage(&record)
                && self
                    .created
                    .same_facts(&observation(&self.created.workflow, &record)?),
            "RESOURCE_NATIVE_CLI_OBSERVATION_CHANGED",
        )
    }
}
impl WorkerRuntime {
    pub fn observe_protected_memory_configured(
        &self,
        configured: &ConfiguredMemory,
        created: &ProtectedCreatedObservation,
        connection: &WorkerLaunchConnection,
    ) -> Result<ProtectedMemoryObservation> {
        need(
            configured.workflow.same_workflow(&created.workflow),
            "RESOURCE_NATIVE_MEMORY_WORKFLOW_CHANGED",
        )?;
        let record = checked_record(self, &configured.workflow, connection)?;
        let observed = observation(&configured.workflow, &record)?;
        need(
            record
                .creation
                .as_ref()
                .is_some_and(|creation| creation.stage == create::CreateStage::MemoryConfigured)
                && observed.same_facts(created),
            "RESOURCE_NATIVE_MEMORY_CREATED_CHANGED",
        )?;
        Ok(ProtectedMemoryObservation { created: observed })
    }
    pub fn observe_protected_created(
        &self,
        created: &CreatedLaptop,
        connection: &WorkerLaunchConnection,
    ) -> Result<ProtectedCreatedObservation> {
        let record = checked_record(self, &created.workflow, connection)?;
        let observed = observation(&created.workflow, &record)?;
        need(
            record
                .creation
                .as_ref()
                .is_some_and(|creation| creation.stage == create::CreateStage::Created)
                && created.container_id() == Some(&observed.container),
            "RESOURCE_NATIVE_CREATED_PHASE",
        )?;
        Ok(observed)
    }
    pub fn observe_protected_cli_started(
        &self,
        pane: &StartedPane,
        created: &ProtectedCreatedObservation,
        connection: &WorkerLaunchConnection,
    ) -> Result<ProtectedCliObservation> {
        need(
            pane.workflow.same_workflow(&created.workflow),
            "RESOURCE_NATIVE_CLI_WORKFLOW_CHANGED",
        )?;
        let record = checked_record(self, &pane.workflow, connection)?;
        let observed = observation(&pane.workflow, &record)?;
        need(
            cli_stage(&record) && observed.same_facts(created),
            "RESOURCE_NATIVE_CLI_CREATED_CHANGED",
        )?;
        Ok(ProtectedCliObservation { created: observed })
    }
}
fn cli_stage(record: &Record) -> bool {
    record.creation.as_ref().is_some_and(|creation| {
        matches!(
            creation.stage,
            create::CreateStage::PaneStarted | create::CreateStage::NixGuardReleased
        )
    })
}
fn checked_record<'a>(
    runtime: &WorkerRuntime,
    workflow: &'a LaptopWorkflow,
    connection: &WorkerLaunchConnection,
) -> Result<MutexGuard<'a, Record>> {
    connection
        .assert_protected_origin()
        .map_err(|_| LaptopError::Refused("RESOURCE_NATIVE_L_CONNECTION_REQUIRED"))?;
    runtime.laptop_workflows().bound(runtime, workflow)?;
    let record = workflow
        .record
        .try_lock()
        .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_RETAINED"))?;
    need(
        record.phase == Phase::Known
            && record.cleanup.is_none()
            && record.pending.is_none()
            && !record.unknown
            && record
                .outcome
                .as_ref()
                .is_some_and(|outcome| outcome.is_ok()),
        "RESOURCE_NATIVE_CREATED_UNCONFIRMED",
    )?;
    let resources = record
        .resources
        .as_ref()
        .ok_or(LaptopError::Refused("WORKER_LAPTOP_REPLAYED"))?;
    let supplied = connection
        .viewer_constructor_identity(runtime, resources.plan.session())
        .map_err(LaptopError::Refused)?;
    need(
        resources
            .connection
            .as_ref()
            .is_some_and(|original| original.same(&supplied)),
        "RESOURCE_NATIVE_L_CONNECTION_CHANGED",
    )?;
    Ok(record)
}
fn observation(workflow: &LaptopWorkflow, record: &Record) -> Result<ProtectedCreatedObservation> {
    let resources = record
        .resources
        .as_ref()
        .ok_or(LaptopError::Refused("WORKER_LAPTOP_REPLAYED"))?;
    let container = record
        .creation
        .as_ref()
        .filter(|creation| creation.owns_created())
        .and_then(|creation| creation.container.as_ref())
        .ok_or(LaptopError::Refused(
            "RESOURCE_NATIVE_CANONICAL_CID_REQUIRED",
        ))?;
    Ok(ProtectedCreatedObservation {
        workflow: workflow.clone(),
        target: resources.plan.session().clone(),
        container: container.clone(),
        config: resources.plan.arguments().config_digest().clone(),
        policy: resources.plan.arguments().policy_digest().clone(),
    })
}
