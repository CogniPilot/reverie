//! Same-runtime daemon/image DATA observations. No OS origin, artifact-source
//! qualification, installation, maintenance or pool-write authority is minted.
mod error;
use crate::{
    engine_metadata::{EngineError, EngineQuery, MetadataQueryOwner, ReadonlyEngine},
    worker_runtime::{WorkerRuntime, WorkerStopBudget},
};
pub use error::PoolTargetObservationError;
use reverie_contracts::{
    worker_image_switch::WorkerImageId,
    worker_pool::{WorkerPoolPolicy, validate_engine_information, validate_pool_image_information},
};
use std::time::Instant;
type Result<T> = std::result::Result<T, PoolTargetObservationError>;

/// Last observation/checked-close state, not a live readiness capability.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PoolTargetPhase {
    Captured,
    Observed,
    Failed,
    Closed,
}

#[must_use = "retain original query custody and check its close result"]
pub struct PoolTargetObservation {
    engine: ReadonlyEngine,
    reader: MetadataQueryOwner,
    stop: WorkerStopBudget,
    policy: WorkerPoolPolicy,
    policy_bytes: Vec<u8>,
    images: [WorkerImageId; 2],
    end: Instant,
    phase: PoolTargetPhase,
    raw: [Option<String>; 3],
    primary: Option<PoolTargetObservationError>,
    cleanup: Option<EngineError>,
}
impl PoolTargetObservation {
    /// Pure capture of validated policy DATA and this exact runtime's shared
    /// reader. The App must separately retain its actual OS offer and qualify
    /// the repository-factory artifacts selected by these immutable image IDs.
    pub fn capture(
        runtime: &WorkerRuntime,
        policy: &WorkerPoolPolicy,
        end: Instant,
    ) -> Result<Self> {
        policy
            .validate()
            .map_err(|_| refused("WORKER_POOL_TARGET_POLICY"))?;
        let policy_bytes = policy_bytes(policy)?;
        let images = [&policy.anchor_image, &policy.controller_image].map(|value| {
            WorkerImageId::parse(value).map_err(|_| refused("WORKER_POOL_TARGET_IMAGE"))
        });
        let [anchor, controller] = images;
        let engine = runtime.readonly();
        let reader = engine.capture_query_owner();
        Ok(Self {
            engine,
            reader,
            stop: runtime.stop_budget(),
            policy: policy.clone(),
            policy_bytes,
            images: [anchor?, controller?],
            end,
            phase: PoolTargetPhase::Captured,
            raw: [None, None, None],
            primary: None,
            cleanup: None,
        })
    }
    pub fn phase(&self) -> PoolTargetPhase {
        self.phase
    }
    pub fn policy_data(&self) -> &WorkerPoolPolicy {
        &self.policy
    }
    pub fn primary_error(&self) -> Option<&PoolTargetObservationError> {
        self.primary.as_ref()
    }
    pub fn cleanup_error(&self) -> Option<&EngineError> {
        self.cleanup.as_ref()
    }

    /// Each successful round has three actual known-closed queries. A later
    /// round uses the SAME owner/end; it cannot clear any earlier failure.
    pub fn observe(&mut self, runtime: &WorkerRuntime, policy: &WorkerPoolPolicy) -> Result<()> {
        if let Some(error) = &self.primary {
            return Err(error.clone());
        }
        if let Some(error) = &self.cleanup {
            return Err(PoolTargetObservationError::Engine(error.clone()));
        }
        if self.phase == PoolTargetPhase::Closed {
            return Err(refused("WORKER_POOL_TARGET_CLOSED"));
        }
        let result = self
            .assert_binding(runtime, policy)
            .and_then(|()| self.observe_round(runtime));
        match result {
            Ok(()) => {
                self.phase = PoolTargetPhase::Observed;
                Ok(())
            }
            Err(error) => {
                self.phase = PoolTargetPhase::Failed;
                self.primary = Some(error.clone());
                Err(error)
            }
        }
    }
    /// Freshly repeat the same fixed observation; a cached phase is DATA only.
    pub fn assert_current(
        &mut self,
        runtime: &WorkerRuntime,
        policy: &WorkerPoolPolicy,
    ) -> Result<()> {
        self.observe(runtime, policy)
    }
    fn assert_binding(&self, runtime: &WorkerRuntime, policy: &WorkerPoolPolicy) -> Result<()> {
        self.assert_runtime(runtime)?;
        if policy_bytes(policy)? != self.policy_bytes {
            return Err(refused("WORKER_POOL_TARGET_POLICY_CHANGED"));
        }
        Ok(())
    }
    fn assert_runtime(&self, runtime: &WorkerRuntime) -> Result<()> {
        if !self.stop.same_runtime(runtime) {
            return Err(refused("WORKER_POOL_TARGET_RUNTIME_CHANGED"));
        }
        self.engine
            .assert_worker_runtime(runtime)
            .map_err(PoolTargetObservationError::Engine)?;
        self.reader
            .assert_engine(&self.engine)
            .map_err(PoolTargetObservationError::Engine)
    }
    fn clipped_end(&self) -> Instant {
        self.stop
            .deadline()
            .map_or(self.end, |stop| self.end.min(stop))
    }
    fn forward_end(&self) -> Result<Instant> {
        let end = self.clipped_end();
        if Instant::now() >= end {
            return Err(refused("WORKER_POOL_TARGET_DEADLINE"));
        }
        Ok(end)
    }
    fn observe_round(&mut self, runtime: &WorkerRuntime) -> Result<()> {
        self.forward_end()?;
        // Only a completed successful previous round reaches this reset.
        // Every new returned raw is retained before its fallible validation.
        self.raw = [None, None, None];
        let info = self
            .reader
            .query(
                EngineQuery::WorkerPoolInformation,
                self.forward_end()?,
                &runtime.cancellation(),
            )
            .map_err(PoolTargetObservationError::Engine)?;
        self.raw[0] = Some(info);
        validate_engine_information(
            self.raw[0]
                .as_ref()
                .expect("original raw stored")
                .as_bytes(),
            &self.policy,
        )
        .map_err(|_| refused("WORKER_POOL_TARGET_DAEMON"))?;
        for index in 0..2 {
            let raw = self
                .reader
                .query(
                    EngineQuery::WorkerImageInspect(&self.images[index]),
                    self.forward_end()?,
                    &runtime.cancellation(),
                )
                .map_err(PoolTargetObservationError::Engine)?;
            self.raw[index + 1] = Some(raw);
            validate_pool_image_information(
                self.raw[index + 1]
                    .as_ref()
                    .expect("original raw stored")
                    .as_bytes(),
                &self.images[index],
            )
            .map_err(|_| refused("WORKER_POOL_TARGET_IMAGE"))?;
        }
        self.forward_end()?;
        Ok(())
    }
    /// Settle only this original query ticket under its original clipped end.
    /// Neither a known body refusal nor later settlement erases the first
    /// cause. A consumed-close uncertainty can never produce Closed credit.
    pub fn close(&mut self, runtime: &WorkerRuntime) -> Result<()> {
        self.assert_runtime(runtime)?;
        if self.phase == PoolTargetPhase::Closed {
            return Ok(());
        }
        if let Err(error) = self.reader.settle_owned(self.clipped_end())
            && self.cleanup.is_none()
        {
            self.cleanup = Some(error);
        }
        if let Some(error) = &self.cleanup {
            self.phase = PoolTargetPhase::Failed;
            return Err(PoolTargetObservationError::Engine(error.clone()));
        }
        if let Some(PoolTargetObservationError::Engine(error)) = &self.primary
            && error.is_uncertain()
        {
            self.phase = PoolTargetPhase::Failed;
            return Err(PoolTargetObservationError::Engine(error.clone()));
        }
        self.phase = PoolTargetPhase::Closed;
        Ok(())
    }
}
fn refused(code: &'static str) -> PoolTargetObservationError {
    PoolTargetObservationError::Refused(code)
}
fn policy_bytes(policy: &WorkerPoolPolicy) -> Result<Vec<u8>> {
    serde_json::to_vec(policy).map_err(|_| refused("WORKER_POOL_TARGET_POLICY"))
}
