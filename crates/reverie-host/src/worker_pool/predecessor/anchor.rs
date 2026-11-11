use super::*;
use reverie_contracts::worker_pool::{
    validate_anchor_inspection, validate_retained_anchor_inspection,
};

pub(super) struct Anchor {
    directory: Option<PoolDirectory>,
    data: Option<RetainedPoolAnchor>,
    raw: Vec<u8>,
}

impl Anchor {
    pub(super) fn unopened(policy: &WorkerPoolPolicy) -> Self {
        Self {
            directory: Some(PoolDirectory::unopened(policy)),
            data: None,
            raw: Vec::new(),
        }
    }

    pub(super) fn observe(
        &mut self,
        engine: &engine::Engine,
        policy: &WorkerPoolPolicy,
        original_birth: &JournalDigest,
        recorded: Option<&RetainedPoolAnchor>,
    ) -> Result<()> {
        let id = match recorded {
            Some(anchor) => ContainerId::parse(anchor.container_id())
                .map_err(|_| PoolError::Refused("WORKER_POOL_PREDECESSOR_ANCHOR_ID"))?,
            None => engine.selected_id(&policy.anchor_name())?,
        };
        self.raw = inspect(engine, &id)?;
        let directory = self
            .directory
            .as_mut()
            .expect("original anchor directory owner");
        let data = match recorded {
            Some(anchor) => {
                validate_retained_anchor_inspection(&self.raw, policy, anchor).map_err(invalid)?;
                directory.acquire_retained(policy, anchor)?;
                anchor.clone()
            }
            None => {
                let pid = legacy_pid(&self.raw)?;
                validate_anchor_inspection(
                    &self.raw,
                    policy,
                    id.as_str(),
                    pid,
                    original_birth.as_str(),
                )
                .map_err(invalid)?;
                let discovered = directory.observe_retained(policy, &id, pid, original_birth)?;
                validate_retained_anchor_inspection(&self.raw, policy, &discovered)
                    .map_err(invalid)?;
                discovered
            }
        };
        self.data = Some(data);
        Ok(())
    }

    pub(super) fn assert_current(
        &self,
        engine: &engine::Engine,
        policy: &WorkerPoolPolicy,
    ) -> Result<()> {
        let data = self.data();
        let directory = self.directory.as_ref().expect("retained anchor directory");
        directory.assert_retained_anchor(data)?;
        let id = ContainerId::parse(data.container_id()).expect("checked retained anchor ID");
        let current = inspect(engine, &id)?;
        validate_retained_anchor_inspection(&current, policy, data).map_err(invalid)?;
        need(
            RecoveryInspection::same_container_object_inspection(id.as_str(), &self.raw, &current)
                .map_err(|_| PoolError::Refused("WORKER_POOL_PREDECESSOR_ANCHOR_INSPECTION"))?,
            "WORKER_POOL_PREDECESSOR_ANCHOR_CHANGED",
        )?;
        directory.assert_retained_anchor(data)?;
        directory.assert_limits(policy)
    }

    pub(super) fn data(&self) -> &RetainedPoolAnchor {
        self.data.as_ref().expect("observed retained anchor")
    }

    pub(super) fn close(&mut self) -> Result<()> {
        if let Some(directory) = &mut self.directory {
            directory.close()?;
            self.directory = None;
        }
        Ok(())
    }
}

impl Drop for Anchor {
    fn drop(&mut self) {
        std::mem::forget(self.directory.take());
    }
}

fn inspect(engine: &engine::Engine, id: &ContainerId) -> Result<Vec<u8>> {
    Ok(engine
        .query(EngineQuery::WorkerPoolWebsiteInspect(id))?
        .into_bytes())
}

fn legacy_pid(raw: &[u8]) -> Result<u32> {
    let row: serde_json::Value = serde_json::from_slice(raw)
        .map_err(|_| PoolError::Refused("WORKER_POOL_PREDECESSOR_ANCHOR_INSPECTION"))?;
    row["State"]["Pid"]
        .as_u64()
        .and_then(|pid| u32::try_from(pid).ok())
        .filter(|&pid| pid > 1)
        .ok_or(PoolError::Refused("WORKER_POOL_PREDECESSOR_ANCHOR_PID"))
}

fn invalid(_: reverie_contracts::worker_pool::PoolPolicyError) -> PoolError {
    PoolError::Refused("WORKER_POOL_PREDECESSOR_ANCHOR_SPEC")
}
