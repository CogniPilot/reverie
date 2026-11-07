//! Actual start acknowledgement only. Memory/retained tmp/native pane readiness
//! remain later required phases; this type cannot register CLI readiness.
use super::call_budget::CallBudget;
use super::*;
use reverie_core::ids::ContainerId;
#[must_use = "retain actual started container resources until checked stop"]
pub struct StartedContainer {
    pub(super) workflow: LaptopWorkflow,
    container: Option<ContainerId>,
}
impl StartedContainer {
    pub fn container_id(&self) -> Option<&ContainerId> {
        self.container.as_ref()
    }
    pub fn same_workflow(&self, other: &LaptopWorkflow) -> bool {
        self.workflow.same_workflow(other)
    }
}
#[must_use = "retain the original created owner on refusal or uncertainty"]
pub enum ContainerStart {
    Started(StartedContainer),
    Rejected,
    Retained,
}
impl Workflows {
    fn start(
        &self,
        runtime: &WorkerRuntime,
        created: &CreatedLaptop,
        deadline: CallBudget,
    ) -> Result<ContainerStart> {
        self.bound(runtime, &created.workflow)?;
        let mut record = created
            .workflow
            .record
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_RETAINED"))?;
        need(
            record.phase == Phase::Known
                && record.creation.as_ref().is_some_and(|state| {
                    state.stage == create::CreateStage::Published
                        && state
                            .publication
                            .as_ref()
                            .is_some_and(publication::Publication::confirmed)
                }),
            "WORKER_LAPTOP_START_PHASE",
        )?;
        record.phase = Phase::Running;
        record
            .creation
            .as_mut()
            .expect("actual created owner")
            .stage = create::CreateStage::Starting;
        let result = run(runtime, &mut record, deadline);
        record.outcome = Some(result.map_err(Arc::new));
        if record.pending.is_some() || record.unknown {
            record.phase = Phase::Retained;
            return Ok(ContainerStart::Retained);
        }
        record.phase = Phase::Known;
        if record.outcome.as_ref().expect("actual result").is_err() {
            return Ok(ContainerStart::Rejected);
        }
        let state = record.creation.as_mut().expect("actual created owner");
        state.stage = create::CreateStage::Started;
        Ok(ContainerStart::Started(StartedContainer {
            workflow: created.workflow.clone(),
            container: state.container.clone(),
        }))
    }
}
fn run(runtime: &WorkerRuntime, record: &mut Record, deadline: CallBudget) -> Result<()> {
    need(
        create::start_allowed(record)?,
        "Current employee running intent changed before startup",
    )?;
    let name = record.resources().plan.arguments().name().to_owned();
    let output = network::call_with_budget(
        runtime,
        record,
        vec!["start".into(), name.into()],
        network::CallPurpose::Launch,
        deadline,
    )?;
    if !output.succeeded {
        record.unknown = true;
        return Err(LaptopError::Refused("WORKER_LAPTOP_START_UNCONFIRMED"));
    }
    Ok(())
}
impl WorkerRuntime {
    /// Requires the same actual created record and confirmed private launch
    /// publication. No CID, serialized receipt or path can mint this owner.
    pub fn start_laptop_container(
        &self,
        created: &CreatedLaptop,
        deadline: Instant,
    ) -> Result<ContainerStart> {
        self.laptop_workflows()
            .start(self, created, CallBudget::bounded(deadline))
    }
    pub fn start_laptop_container_for_connection(
        &self,
        created: &CreatedLaptop,
        connection: &crate::worker_reports::WorkerLaunchConnection,
    ) -> Result<ContainerStart> {
        self.laptop_workflows()
            .assert_worker_connection(self, &created.workflow, connection)?;
        self.laptop_workflows()
            .start(self, created, CallBudget::worker())
    }
}
