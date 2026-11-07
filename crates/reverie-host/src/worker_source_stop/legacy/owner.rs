//! Move-only ordinary stop custody. This does not manufacture a running
//! process incarnation, protected baseline or global resource-release receipt.
use super::*;
#[must_use = "retain the same actual storage and native attempt on uncertainty"]
pub struct OrdinaryLaptopStop {
    attempt: OrdinaryStopAttempt,
    storage: Option<Box<LaunchStorage>>,
    plan: Option<ObservedCreatePlan>,
    original: Option<ExistingLaptopInspection>,
}
#[must_use = "restore every original input on a pre-effect refusal"]
pub struct OrdinaryLaptopStopRetainFailure {
    storage: Box<LaunchStorage>,
    plan: ObservedCreatePlan,
    original: Option<ExistingLaptopInspection>,
    cause: SourceStopError,
}
impl OrdinaryLaptopStopRetainFailure {
    pub fn into_parts(
        self,
    ) -> (
        Box<LaunchStorage>,
        ObservedCreatePlan,
        Option<ExistingLaptopInspection>,
        SourceStopError,
    ) {
        (self.storage, self.plan, self.original, self.cause)
    }
}
#[must_use = "restore to the same App owner; this is not resource close or release"]
pub struct OrdinaryLaptopReturned {
    storage: Box<LaunchStorage>,
    plan: ObservedCreatePlan,
    original: Option<ExistingLaptopInspection>,
}
impl OrdinaryLaptopReturned {
    pub fn into_parts(
        self,
    ) -> (
        Box<LaunchStorage>,
        ObservedCreatePlan,
        Option<ExistingLaptopInspection>,
    ) {
        (self.storage, self.plan, self.original)
    }
}
impl WorkerRuntime {
    /// Pure same-owner transfer. App must perform its actual stop admission
    /// before invoking stop_after_admission; decoded inspection DATA is no grant.
    pub fn retain_ordinary_laptop_stop(
        &self,
        storage: Box<LaunchStorage>,
        plan: ObservedCreatePlan,
        original: ExistingLaptopInspection,
        end: Instant,
    ) -> std::result::Result<OrdinaryLaptopStop, Box<OrdinaryLaptopStopRetainFailure>> {
        retain(self, storage, plan, Some(original), Some(end))
    }
    /// No absent DTO/flag is supplied. The actual first inspect and complete
    /// census inside stop_after_admission must establish target or absence.
    pub fn retain_unobserved_ordinary_laptop_stop(
        &self,
        storage: Box<LaunchStorage>,
        plan: ObservedCreatePlan,
        end: Instant,
    ) -> std::result::Result<OrdinaryLaptopStop, Box<OrdinaryLaptopStopRetainFailure>> {
        retain(self, storage, plan, None, Some(end))
    }
    /// Original broker policy: no invented aggregate stop-body budget. Each
    /// query retains its original 20-second cap and actual first-stop bound.
    pub fn retain_ordinary_laptop_stop_for_worker(
        &self,
        storage: Box<LaunchStorage>,
        plan: ObservedCreatePlan,
        original: ExistingLaptopInspection,
    ) -> std::result::Result<OrdinaryLaptopStop, Box<OrdinaryLaptopStopRetainFailure>> {
        retain(self, storage, plan, Some(original), None)
    }
    /// Absence is still established by actual inspect/census after admission;
    /// selecting original broker timing supplies no absence or effect grant.
    pub fn retain_unobserved_ordinary_laptop_stop_for_worker(
        &self,
        storage: Box<LaunchStorage>,
        plan: ObservedCreatePlan,
    ) -> std::result::Result<OrdinaryLaptopStop, Box<OrdinaryLaptopStopRetainFailure>> {
        retain(self, storage, plan, None, None)
    }
}
fn retain(
    runtime: &WorkerRuntime,
    storage: Box<LaunchStorage>,
    plan: ObservedCreatePlan,
    original: Option<ExistingLaptopInspection>,
    end: Option<Instant>,
) -> std::result::Result<OrdinaryLaptopStop, Box<OrdinaryLaptopStopRetainFailure>> {
    match OrdinaryStopAttempt::new(runtime, &storage, &plan, original.as_ref(), end) {
        Ok(attempt) => Ok(OrdinaryLaptopStop {
            attempt,
            storage: Some(storage),
            plan: Some(plan),
            original,
        }),
        Err(cause) => Err(Box::new(OrdinaryLaptopStopRetainFailure {
            storage,
            plan,
            original,
            cause,
        })),
    }
}
impl OrdinaryLaptopStop {
    pub fn stop_after_admission(&mut self, runtime: &WorkerRuntime) -> Result<()> {
        self.plan
            .as_ref()
            .ok_or(SourceStopError::Refused("WORKER_ORDINARY_STOP_CONSUMED"))?
            .assert_storage_owner(runtime, self.storage.as_ref().expect("same actual Box"))
            .map_err(SourceStopError::Plan)?;
        self.attempt.run(runtime)
    }
    pub fn settle_native(&mut self, runtime: &WorkerRuntime, end: Instant) -> Result<()> {
        self.attempt.settle(runtime, end)
    }
    pub fn failure(&self) -> Option<&Arc<SourceStopError>> {
        self.attempt.failure()
    }
    pub fn take_stopped(
        &mut self,
        runtime: &WorkerRuntime,
        end: Instant,
    ) -> Result<OrdinaryLaptopReturned> {
        need(self.attempt.confirmed(), "WORKER_ORDINARY_STOP_UNCONFIRMED")?;
        self.attempt.settle(runtime, end)?;
        need(self.storage.is_some(), "WORKER_ORDINARY_STOP_CONSUMED")?;
        self.plan
            .as_ref()
            .expect("same original plan")
            .assert_storage_owner(
                runtime,
                self.storage.as_ref().expect("checked original Box"),
            )
            .map_err(SourceStopError::Plan)?;
        Ok(OrdinaryLaptopReturned {
            storage: self.storage.take().expect("checked actual Box"),
            plan: self.plan.take().expect("same original plan"),
            original: self.original.take(),
        })
    }
}
impl Drop for OrdinaryLaptopStop {
    fn drop(&mut self) {
        if let Some(storage) = self.storage.take() {
            quarantine(
                self.attempt.origin.clone(),
                storage,
                self.attempt.pending.take(),
                self.attempt.failure.take(),
            );
        }
    }
}
