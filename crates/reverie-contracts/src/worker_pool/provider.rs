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
pub struct WorkerPoolProvider {
    version: u32,
    purpose: String,
    policy: WorkerPoolPolicy,
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
        let provider: Self = serde_json::from_slice(&crate::worker_config::compact_data(value))
            .map_err(|_| PoolPolicyError)?;
        if provider.version != 1 || provider.purpose != PURPOSE {
            return Err(PoolPolicyError);
        }
        provider.policy.validate()?;
        Ok(Some(provider))
    }
    pub fn policy(&self) -> &WorkerPoolPolicy {
        &self.policy
    }
}
