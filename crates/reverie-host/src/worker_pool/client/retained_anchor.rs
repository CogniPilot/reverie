//! Capture recovery data from the actually installed controller. This neither
//! creates a controller nor grants any later retirement/recovery effect.
use super::*;
use crate::worker_pool::service::check;
use reverie_contracts::worker_pool::{RetainedPoolAnchor, validate_retained_anchor_inspection};
use reverie_core::operations::JournalDigest;

impl ActivatedController {
    pub fn retained_anchor_data(
        &mut self,
        runtime: &WorkerRuntime,
        end: Instant,
    ) -> Result<RetainedPoolAnchor> {
        let owner = self.state_mut();
        let end = owner
            .binding
            .stop
            .deadline()
            .map_or(end, |stop| stop.min(end));
        let result = owner.observe_retained_anchor(runtime, end);
        match result {
            Err(cause) if cause.close_unknown() => {
                owner.retain_native_error(cause);
                Err(PoolError::Refused("WORKER_POOL_CAPACITY_RETAINED"))
            }
            other => other,
        }
    }
}

impl ControllerState {
    fn observe_retained_anchor(
        &mut self,
        runtime: &WorkerRuntime,
        end: Instant,
    ) -> Result<RetainedPoolAnchor> {
        self.assert_current(runtime, end)?;
        let anchor = self
            .anchor
            .as_deref()
            .ok_or(PoolError::Refused("WORKER_POOL_ANCHOR_UNKNOWN"))?;
        let anchor = ContainerId::parse(anchor)
            .map_err(|_| PoolError::Refused("WORKER_POOL_ANCHOR_IDENTITY"))?;
        let digest = self
            .publication
            .retained_anchor()
            .map(|old| old.original_birth_digest().to_owned())
            .unwrap_or_else(|| hex(self.digest));
        let birth = JournalDigest::parse(&digest)
            .map_err(|_| PoolError::Refused("WORKER_POOL_RETAINED_ANCHOR_DATA"))?;
        let captured = self
            .directory
            .retained_anchor_data(&anchor, self.anchor_pid, &birth)?;
        let raw = self
            .query
            .query(
                EngineQuery::WorkerPoolWebsiteInspect(&anchor),
                end,
                &runtime.cancellation(),
            )
            .map_err(PoolError::Engine)?;
        validate_retained_anchor_inspection(raw.as_bytes(), &self.policy, &captured)
            .map_err(|_| PoolError::Refused("WORKER_POOL_RETAINED_ANCHOR_CHANGED"))?;
        self.assert_current(runtime, end)?;
        self.directory.assert_retained_anchor(&captured)?;
        check(end)?;
        Ok(captured)
    }
}
