//! Actual ordinary replacement ownership, distinct from a protected claim.
use super::*;
use crate::worker_launch::{ExistingProcessIncarnation, ObservedCreatePlan};
use reverie_core::worker_laptop::WorkerContainerName;

#[must_use = "retain the original resource and pending native call on uncertainty"]
pub struct OrdinaryReplacementStop {
    inner: ExactStopAttempt,
    plan: Option<ObservedCreatePlan>,
    process: Option<ExistingProcessIncarnation>,
}
#[must_use = "restore ALL original inputs after refused retention"]
pub struct OrdinaryStopRetainFailure {
    storage: Box<LaunchStorage>,
    plan: ObservedCreatePlan,
    process: ExistingProcessIncarnation,
    cause: SourceStopError,
}
impl OrdinaryStopRetainFailure {
    pub fn into_parts(
        self,
    ) -> (
        Box<LaunchStorage>,
        ObservedCreatePlan,
        ExistingProcessIncarnation,
        SourceStopError,
    ) {
        (self.storage, self.plan, self.process, self.cause)
    }
}
#[must_use = "local stopped readback is not lease release or global capacity credit"]
pub struct OrdinaryReplacementReturned {
    storage: Box<LaunchStorage>,
    plan: ObservedCreatePlan,
    process: ExistingProcessIncarnation,
    removal: StoppedLaptopRemoval,
}
impl OrdinaryReplacementReturned {
    pub fn into_cold_parts(
        self,
    ) -> (
        Box<LaunchStorage>,
        ObservedCreatePlan,
        ExistingProcessIncarnation,
        StoppedLaptopRemoval,
    ) {
        (self.storage, self.plan, self.process, self.removal)
    }
    pub fn into_parts(
        self,
    ) -> (
        Box<LaunchStorage>,
        ObservedCreatePlan,
        ExistingProcessIncarnation,
    ) {
        (self.storage, self.plan, self.process)
    }
}
impl WorkerRuntime {
    /// The actual App must first perform its canonical reservation stop fence
    /// under the SAME admission/lifecycle. This factory supplies no authority.
    pub fn retain_ordinary_replacement_stop(
        &self,
        storage: Box<LaunchStorage>,
        plan: ObservedCreatePlan,
        process: ExistingProcessIncarnation,
        deadline: Option<Instant>,
    ) -> std::result::Result<OrdinaryReplacementStop, Box<OrdinaryStopRetainFailure>> {
        match ordinary_identity(self, &storage, &plan, &process) {
            Ok(name) => Ok(OrdinaryReplacementStop {
                inner: ExactStopAttempt {
                    origin: self.installed_engine().clone(),
                    storage: Some(storage),
                    name,
                    phase: Phase::Held,
                    deadline,
                    inspection: None,
                    metadata: None,
                    original_start: None,
                    pending: None,
                    failure: None,
                },
                plan: Some(plan),
                process: Some(process),
            }),
            Err(cause) => Err(Box::new(OrdinaryStopRetainFailure {
                storage,
                plan,
                process,
                cause,
            })),
        }
    }
}
fn ordinary_identity(
    runtime: &WorkerRuntime,
    storage: &LaunchStorage,
    plan: &ObservedCreatePlan,
    process: &ExistingProcessIncarnation,
) -> Result<StopIdentity> {
    process
        .assert_plan(runtime, plan)
        .map_err(SourceStopError::Observation)?;
    process
        .assert_storage_owner(runtime, storage)
        .map_err(SourceStopError::Observation)?;
    let name = WorkerContainerName::from_launch_name_data(plan.arguments().worker_name());
    need(
        name.as_str() == plan.arguments().name() && name.as_str() == process.name().as_str(),
        "Exact owned laptop identity required",
    )?;
    let container = process
        .data()
        .canonical_id()
        .ok_or(SourceStopError::Data(SourceStopDataError::Name))?;
    Ok(StopIdentity::Ordinary {
        name,
        session: process.session().clone(),
        container,
        pid: process.pid().clone(),
        start: process.start().to_owned(),
    })
}
impl OrdinaryReplacementStop {
    pub fn inspect(&mut self, runtime: &WorkerRuntime) -> Result<()> {
        self.inner.inspect(runtime)
    }
    pub fn refuse_policy(&mut self, runtime: &WorkerRuntime) -> Result<()> {
        self.inner.refuse_policy(runtime)
    }
    pub fn stop_after_policy(
        &mut self,
        runtime: &WorkerRuntime,
        policy: &reverie_contracts::worker_config::WorkerPolicyDigest,
    ) -> Result<()> {
        self.inner.stop_after_policy(runtime, policy)
    }
    pub fn settle_native(&mut self, runtime: &WorkerRuntime, end: Instant) -> Result<()> {
        self.inner.settle_native(runtime, end)
    }
    pub fn failure(&self) -> Option<&Arc<SourceStopError>> {
        self.inner.failure.as_ref()
    }
    /// The caller must prevalidate its SAME registry entry before this method.
    /// All fallible checks precede extraction; restoration after into_parts is
    /// infallible and keeps the exact Box allocation and original observations.
    pub fn take_stopped(
        &mut self,
        runtime: &WorkerRuntime,
        end: Instant,
    ) -> Result<OrdinaryReplacementReturned> {
        self.inner.bound(runtime)?;
        need(
            self.inner.phase == Phase::Stopped,
            "WORKER_ORDINARY_STOP_UNCONFIRMED",
        )?;
        self.inner.settle_native(runtime, end)?;
        let removal = StoppedLaptopRemoval::exact(&mut self.inner);
        let storage = self.inner.storage.take().expect("actual stopped resource");
        let plan = self.plan.take().expect("actual original plan");
        let process = self.process.take().expect("actual original process");
        self.inner.phase = Phase::Closed;
        Ok(OrdinaryReplacementReturned {
            storage,
            plan,
            process,
            removal,
        })
    }
}

impl OrdinaryReplacementStop {
    /// Closed local DATA; never settles or advances this owner.
    pub fn storage_owner_status(
        &self,
    ) -> reverie_contracts::worker_storage_status::OwnerObservation {
        self.inner.diagnostic()
    }
}
