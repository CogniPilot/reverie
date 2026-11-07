//! Ordinary by-name lifecycle, distinct from protected or process-incarnation
//! replacement. Actual same-resource callers retain this attempt on failure.
use super::*;
use crate::worker_launch::{ExistingLaptopInspection, ObservedCreatePlan};
use reverie_core::ids::{ContainerId, ProfileSessionId};
use std::{ffi::OsString, time::Duration};
mod container;
mod network;
mod owner;
pub use owner::{OrdinaryLaptopReturned, OrdinaryLaptopStop, OrdinaryLaptopStopRetainFailure};

#[derive(Clone, Copy, Eq, PartialEq)]
enum LegacyPhase {
    Held,
    Attempted,
    Confirmed,
    Failed,
}
pub(crate) struct OrdinaryStopAttempt {
    origin: Arc<InstalledWorkerEngine>,
    phase: LegacyPhase,
    name: String,
    session: ProfileSessionId,
    container: Option<ContainerId>,
    deadline: Instant,
    pending: Option<CapturedCall>,
    failure: Option<Arc<SourceStopError>>,
}
impl OrdinaryStopAttempt {
    pub(crate) fn new(
        runtime: &WorkerRuntime,
        storage: &LaunchStorage,
        plan: &ObservedCreatePlan,
        inspection: Option<&ExistingLaptopInspection>,
        deadline: Instant,
    ) -> Result<Self> {
        plan.assert_storage_owner(runtime, storage)
            .map_err(SourceStopError::Plan)?;
        let container = if let Some(inspection) = inspection {
            inspection
                .assert_plan(runtime, plan)
                .map_err(SourceStopError::Observation)?;
            Some(
                inspection
                    .data()
                    .canonical_id()
                    .ok_or(SourceStopError::Data(SourceStopDataError::Identity))?,
            )
        } else {
            None
        };
        Ok(Self {
            origin: runtime.installed_engine().clone(),
            phase: LegacyPhase::Held,
            name: plan.arguments().name().to_owned(),
            session: plan.session().clone(),
            container,
            deadline,
            pending: None,
            failure: None,
        })
    }
    pub(crate) fn run(&mut self, runtime: &WorkerRuntime) -> Result<()> {
        self.bound(runtime)?;
        need(
            self.phase == LegacyPhase::Held,
            "WORKER_ORDINARY_STOP_ALREADY_ATTEMPTED",
        )?;
        // This latch precedes even observation admission. A later local close
        // cannot transform an attempted unknown stop into a reclaimable Box.
        self.phase = LegacyPhase::Attempted;
        let result = self
            .stop_container(runtime)
            .and_then(|()| self.cleanup_network(runtime));
        match result {
            Ok(()) => {
                self.phase = LegacyPhase::Confirmed;
                Ok(())
            }
            Err(error) => {
                self.phase = LegacyPhase::Failed;
                let error = Arc::new(error);
                self.failure = Some(error.clone());
                Err(SourceStopError::Recorded(error))
            }
        }
    }
    pub(crate) fn confirmed(&self) -> bool {
        self.phase == LegacyPhase::Confirmed
    }
    pub(crate) fn failure(&self) -> Option<&Arc<SourceStopError>> {
        self.failure.as_ref()
    }
    pub(crate) fn settle(&mut self, runtime: &WorkerRuntime, end: Instant) -> Result<()> {
        self.bound(runtime)?;
        if let Some(call) = &self.pending {
            // The operation has already failed. Its expired attempt deadline
            // cannot forbid bounded cleanup of the exact retained native job.
            // First-stop remains the one shared service cleanup budget.
            let end = self
                .origin
                .stop_deadline()
                .map_or(end, |stop| end.min(stop));
            self.origin
                .engine
                .client
                .settle_call(call, end)
                .map_err(|error| SourceStopError::Engine(error.into()))?;
            self.pending = None;
        }
        Ok(())
    }
    fn bound(&self, runtime: &WorkerRuntime) -> Result<()> {
        need(
            Arc::ptr_eq(&self.origin, runtime.installed_engine()),
            "WORKER_ORDINARY_STOP_RUNTIME",
        )
    }
    fn clipped(&self, end: Instant) -> Instant {
        let end = self.deadline.min(end);
        self.origin
            .stop_deadline()
            .map_or(end, |stop| end.min(stop))
    }
    fn call(
        &mut self,
        args: Vec<OsString>,
        required: bool,
    ) -> Result<crate::captured_client::CapturedOutput> {
        let end = self.clipped(Instant::now() + Duration::from_secs(20));
        call::captured(&self.origin, end, &mut self.pending, args, required)
    }
}
