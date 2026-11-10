//! Actual fixed create, derived only from the same retained resource record.
//! Successful noncanonical stdout still owns the created-by-name outcome.
use super::call_budget::CallBudget;
use super::*;
mod diagnostic;
mod perf_image;
use crate::command_telemetry::CommandTelemetry;
pub use diagnostic::LaptopCreateDiagnostic;
use reverie_contracts::{resource_config::ResourceIdentitySettings, worker_launch};
use reverie_core::{PythonTextRef, ids::ContainerId};
use reverie_store::storage_identity::{self, StorageIdentityConfig, StorageKind};

#[derive(Clone, Copy, Eq, PartialEq)]
pub(super) enum CreateStage {
    Preparing,
    Created,
    Publishing,
    Published,
    Starting,
    Started,
    ConfiguringMemory,
    MemoryConfigured,
    CommittingCold,
    ColdCommitted,
    StartingPane,
    PaneStarted,
    ReleasingNixGuard,
    NixGuardReleased,
    StartingViewer,
    Viewing,
}
pub(super) struct Creation {
    created: bool,
    diagnostic: Option<Arc<LaptopCreateDiagnostic>>,
    pub(super) container: Option<ContainerId>,
    pub(super) stage: CreateStage,
    pub(super) publication: Option<super::publication::Publication>,
    pub(super) worker_memory: Option<super::memory::Pending>,
    pub(super) worker_perf: Option<super::perf::Attempt>,
}
impl Creation {
    pub(super) fn owns_created(&self) -> bool {
        self.created
    }
}
/// Minted only from the actual successful create invocation, never CID/name DATA.
/// This owner is not CLI readiness, protected authorization or a release receipt.
#[must_use = "retain the actual created resource record through start/checked stop"]
pub struct CreatedLaptop {
    pub(super) workflow: LaptopWorkflow,
    container: Option<ContainerId>,
}
impl CreatedLaptop {
    pub fn container_id(&self) -> Option<&ContainerId> {
        self.container.as_ref()
    }
    pub fn same_workflow(&self, other: &LaptopWorkflow) -> bool {
        self.workflow.same_workflow(other)
    }
}
#[must_use = "keep the workflow on rejected or uncertain create outcomes"]
pub enum LaptopCreation {
    Created(CreatedLaptop),
    Rejected,
    Retained,
}
impl Workflows {
    fn create(
        &self,
        runtime: &WorkerRuntime,
        workflow: &LaptopWorkflow,
        telemetry: &CommandTelemetry,
        deadline: CallBudget,
    ) -> Result<LaptopCreation> {
        self.bound(runtime, workflow)?;
        let mut record = workflow
            .record
            .try_lock()
            .map_err(|_| LaptopError::Refused("WORKER_LAPTOP_RETAINED"))?;
        need(
            record.phase == Phase::Known
                && record
                    .outcome
                    .as_ref()
                    .is_some_and(|outcome| outcome.is_ok())
                && record.creation.is_none(),
            "WORKER_LAPTOP_CREATE_PHASE",
        )?;
        // The retained plan may precede the App's latest source read. Until a
        // genuine provider-maintenance owner is joined, neither snapshot may
        // turn native-provider selection into an ordinary legacy create.
        let provider = reverie_contracts::worker_pool::WorkerPoolProvider::from_config(
            record.resources().plan.source(),
        )
        .map_err(|_| LaptopError::Refused("WORKER_POOL_PROVIDER_INVALID"))?;
        need(
            provider.is_none(),
            "WORKER_POOL_PROVIDER_MAINTENANCE_REQUIRED",
        )?;
        // Retain the one-shot phase before the first possible constructor.
        record.creation = Some(Creation {
            created: false,
            diagnostic: None,
            container: None,
            stage: CreateStage::Preparing,
            publication: None,
            worker_memory: None,
            worker_perf: None,
        });
        record.phase = Phase::Running;
        let result = run(runtime, &mut record, telemetry, deadline);
        record.outcome = Some(result.map_err(Arc::new));
        if record.pending.is_some() || record.unknown {
            record.phase = Phase::Retained;
            return Ok(LaptopCreation::Retained);
        }
        record.phase = Phase::Known;
        if record
            .outcome
            .as_ref()
            .expect("actual create result")
            .is_err()
        {
            return Ok(LaptopCreation::Rejected);
        }
        Ok(LaptopCreation::Created(CreatedLaptop {
            workflow: workflow.clone(),
            container: record
                .creation
                .as_ref()
                .expect("one-shot create")
                .container
                .clone(),
        }))
    }
}
fn run(
    runtime: &WorkerRuntime,
    record: &mut Record,
    telemetry: &CommandTelemetry,
    deadline: CallBudget,
) -> Result<()> {
    telemetry
        .assert_runtime(runtime)
        .map_err(|error| LaptopError::Telemetry(CreateTelemetryFailure::new(error)))?;
    perf_image::assert_current(runtime, record, deadline)?;
    let resources = record.resources();
    resources
        .held_nix()?
        .assert_create_plan(runtime, &resources.plan)
        .map_err(LaptopError::Plan)?;
    resources
        .held_nix()?
        .require_cold_prepared(resources.plan.source())?;
    let accounts = crate::worker_launch::account_mounts(
        resources.plan.source(),
        resources.request.environment(),
    )
    .map_err(|error| {
        LaptopError::Plan(crate::worker_launch::CreateObservationError::Host(error))
    })?;
    let nix = resources
        .nix
        .prepared_path()
        .map(|path| worker_launch::storage_path_text(&crate::native::python_text(path)))
        .transpose()
        .map_err(LaptopError::Data)?;
    let args = resources
        .plan
        .arguments()
        .with_late_mounts(nix.as_ref(), &accounts);
    need(
        start_allowed(record)?,
        "Current employee running intent changed before creation",
    )?;
    // Last source-level check before actual create. No mount omission, stale
    // account reparse, report-lock substitute or optional collector fallback.
    telemetry
        .check_create_args(runtime, &args)
        .map_err(|error| LaptopError::Telemetry(CreateTelemetryFailure::new(error)))?;
    let argv = network::encode_arguments(&args)?;
    let output = network::call_with_budget(
        runtime,
        record,
        argv.clone(),
        network::CallPurpose::Launch,
        deadline,
    )?;
    if !output.succeeded {
        let diagnostic = Arc::new(LaptopCreateDiagnostic::capture_completed(argv, output));
        record
            .creation
            .as_mut()
            .expect("retained one-shot create")
            .diagnostic = Some(diagnostic);
        // A nonzero client can still have caused a daemon effect. Keep every
        // owner; local client completion is not an absent-container proof.
        record.unknown = true;
        return Err(LaptopError::Refused("WORKER_LAPTOP_CREATE_UNCONFIRMED"));
    }
    let created = record.creation.as_mut().expect("retained one-shot create");
    created.created = true;
    created.stage = CreateStage::Created;
    let text = std::str::from_utf8(&output.stdout).expect("captured UTF8 policy");
    let trimmed = PythonTextRef::from_scalar_text(text)
        .trimmed()
        .scalar_text()
        .expect("scalar capture");
    created.container = ContainerId::parse(&trimmed).ok();
    Ok(())
}
pub(super) fn start_allowed(record: &Record) -> Result<bool> {
    let plan = &record.resources().plan;
    if plan.storage().kind() != StorageKind::Employee {
        return Ok(true);
    }
    let settings = ResourceIdentitySettings::capture_worker_config(plan.source())
        .map_err(LaptopError::Configuration)?;
    storage_identity::storage_start_allowed(
        &StorageIdentityConfig::capture_worker_settings(&settings),
        plan.storage(),
    )
    .map_err(LaptopError::Identity)
}
impl WorkerRuntime {
    /// Closed create purpose over real retained resources; App is the sole
    /// canonical caller under its actual admission/current lifecycle owner.
    /// No argv, CID, path or serialized permit can construct this workflow.
    pub fn create_laptop(
        &self,
        workflow: &LaptopWorkflow,
        telemetry: &CommandTelemetry,
        deadline: Instant,
    ) -> Result<LaptopCreation> {
        self.laptop_workflows()
            .create(self, workflow, telemetry, CallBudget::bounded(deadline))
    }
    pub fn create_laptop_for_connection(
        &self,
        workflow: &LaptopWorkflow,
        telemetry: &CommandTelemetry,
        connection: &crate::worker_reports::WorkerLaunchConnection,
    ) -> Result<LaptopCreation> {
        self.laptop_workflows()
            .assert_worker_connection(self, workflow, connection)?;
        self.laptop_workflows()
            .create(self, workflow, telemetry, CallBudget::worker())
    }
}
