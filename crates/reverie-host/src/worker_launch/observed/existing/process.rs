//! Original _pid capture over the actual first engine observation. Readback is
//! not stop/start permission: effects also need SAME real resource custody,
//! actual App sequencing and fresh native/late-policy fences.
use super::*;
use crate::worker_storage::LaunchStorage;
use reverie_core::{decimal::UnsignedInteger, ids::ProfileSessionId, worker_launch::WorkerName};

#[must_use = "retain with the original resource and application admission"]
pub struct ExistingProcessIncarnation {
    observed: ExistingLaptopInspection,
    source: EffectiveWorkerConfig,
    name: WorkerName,
    session: ProfileSessionId,
    pid: UnsignedInteger,
    start: String,
}
impl ExistingProcessIncarnation {
    pub fn data(&self) -> &LaunchLaptopInspection {
        self.observed.data()
    }
    pub fn name(&self) -> &WorkerName {
        &self.name
    }
    pub fn session(&self) -> &ProfileSessionId {
        &self.session
    }
    pub fn source_configuration(&self) -> &EffectiveWorkerConfig {
        &self.source
    }
    pub fn pid(&self) -> &UnsignedInteger {
        &self.pid
    }
    pub fn start(&self) -> &str {
        &self.start
    }
    /// Pure origin/resource generation, not current FD custody, process
    /// freshness, authorization or a stopped-source acknowledgement.
    pub fn assert_storage_owner(
        &self,
        runtime: &WorkerRuntime,
        storage: &LaunchStorage,
    ) -> std::result::Result<(), ExistingObservationError> {
        if !Arc::ptr_eq(&self.observed.origin, runtime.installed_engine())
            || !Arc::ptr_eq(&self.observed.storage_owner, storage.owner_identity())
        {
            return Err(ExistingObservationError::Origin);
        }
        storage
            .assert_binding(runtime, &self.source, &self.session)
            .map_err(ExistingObservationError::Owner)
    }
}
#[must_use = "retain the genuine observation; never reconstruct it from reply data"]
pub struct ExistingCaptureFailure {
    observation: ExistingLaptopInspection,
    cause: ExistingObservationError,
}
impl ExistingCaptureFailure {
    pub fn observation_data(&self) -> &LaunchLaptopInspection {
        self.observation.data()
    }
    pub fn cause(&self) -> &ExistingObservationError {
        &self.cause
    }
}
impl std::fmt::Debug for ExistingCaptureFailure {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.debug_tuple("ExistingCaptureFailure")
            .field(&self.cause)
            .finish()
    }
}
impl std::fmt::Display for ExistingCaptureFailure {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.cause.fmt(out)
    }
}
impl std::error::Error for ExistingCaptureFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.cause)
    }
}
impl ExistingLaptopInspection {
    /// At the original positive dead-pane point, before the SECOND pane query.
    /// Source requires Id presence here; canonical effect identity is later.
    pub fn capture_dead_pane_process(
        self,
        runtime: &WorkerRuntime,
        plan: &ObservedCreatePlan,
        end: Instant,
    ) -> std::result::Result<ExistingProcessIncarnation, Box<ExistingCaptureFailure>> {
        let result = (|| {
            self.assert_plan(runtime, plan)?;
            let pid = self
                .data
                .positive_process_id()
                .map_err(ExistingObservationError::Data)?;
            self.data
                .require_id_field()
                .map_err(ExistingObservationError::Data)?;
            Self::read_process(runtime, &pid, end).map(|start| (pid, start))
        })();
        self.finish_capture(plan, result)
    }
    /// No-dead-inner running replacement checks canonical Id BEFORE _pid. No
    /// public bool selector can silently choose a different source phase.
    pub fn capture_running_replacement_process(
        self,
        runtime: &WorkerRuntime,
        plan: &ObservedCreatePlan,
        end: Instant,
    ) -> std::result::Result<ExistingProcessIncarnation, Box<ExistingCaptureFailure>> {
        let result = (|| {
            self.assert_plan(runtime, plan)?;
            let pid = self
                .data
                .positive_process_id()
                .map_err(ExistingObservationError::Data)?;
            if self.data.canonical_id().is_none() {
                return Err(ExistingObservationError::Data(LaptopReadError::Process));
            }
            Self::read_process(runtime, &pid, end).map(|start| (pid, start))
        })();
        self.finish_capture(plan, result)
    }
    fn read_process(
        runtime: &WorkerRuntime,
        pid: &UnsignedInteger,
        supplied: Instant,
    ) -> std::result::Result<String, ExistingObservationError> {
        let end = runtime
            .stop_deadline()
            .map_or(supplied, |stop| supplied.min(stop));
        crate::reservation_kernel::existing_process_start(pid, end)
            .map_err(ExistingObservationError::Kernel)
    }
    fn finish_capture(
        self,
        plan: &ObservedCreatePlan,
        result: std::result::Result<(UnsignedInteger, String), ExistingObservationError>,
    ) -> std::result::Result<ExistingProcessIncarnation, Box<ExistingCaptureFailure>> {
        match result {
            Ok((pid, start)) => Ok(ExistingProcessIncarnation {
                observed: self,
                source: plan.source.clone(),
                name: plan.arguments.worker_name().clone(),
                session: plan.session.clone(),
                pid,
                start,
            }),
            Err(cause) => Err(Box::new(ExistingCaptureFailure {
                observation: self,
                cause,
            })),
        }
    }
}
