//! Explicit native-provider selection. A parsed selection grants no effects,
//! admission discount, fence removal or fleet approval.
use super::{PoolPolicyError, WorkerPoolPolicy};
use crate::{
    legacy_json::{Node, Text},
    worker_config::EffectiveWorkerConfig,
};
use serde::Deserialize;

const PURPOSE: &str = "reverie-docker-worker-pool-provider-v1";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UncheckedProvider {
    version: u32,
    purpose: String,
    policy: WorkerPoolPolicy,
}
/// Validated selection DATA. Only the checked configuration reader constructs
/// this wrapper; serde cannot bypass its version, purpose or policy checks.
pub struct WorkerPoolProvider {
    policy: WorkerPoolPolicy,
}
impl UncheckedProvider {
    fn checked(self) -> Result<WorkerPoolProvider, PoolPolicyError> {
        if self.version != 1 || self.purpose != PURPOSE {
            return Err(PoolPolicyError);
        }
        self.policy.validate()?;
        Ok(WorkerPoolProvider { policy: self.policy })
    }
}
impl WorkerPoolProvider {
    pub fn from_config(config: &EffectiveWorkerConfig) -> Result<Option<Self>, PoolPolicyError> {
        let Node::Object(root) = &config.as_value().0 else {
            return Err(PoolPolicyError);
        };
        let key = Text("workerPoolProvider".chars().map(u32::from).collect());
        let Some(value) = root.get(&key) else {
            return Ok(None);
        };
        let provider: UncheckedProvider = serde_json::from_slice(&crate::worker_config::compact_data(value))
            .map_err(|_| PoolPolicyError)?;
        provider.checked().map(Some)
    }
    pub fn policy(&self) -> &WorkerPoolPolicy {
        &self.policy
    }
}
