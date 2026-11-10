//! Explicit native-provider selection. A parsed selection grants no effects,
//! admission discount, fence removal or fleet approval.
use super::{PoolPolicyError, WorkerPoolMemberPolicy, WorkerPoolPolicy};
use crate::{
    legacy_json::{self, Node, Text, Value},
    worker_config::EffectiveWorkerConfig,
};
use reverie_core::ids::ProfileEmployeeId;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub(super) const PURPOSE: &str = "reverie-docker-worker-pool-provider-v1";
const EDITABLE_PURPOSE: &str = "reverie-docker-worker-pool-provider-v2";

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ProviderV1 {
    version: u32,
    purpose: String,
    policy: WorkerPoolPolicy,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ProviderV2 {
    version: u32,
    purpose: String,
    policy: WorkerPoolPolicy,
    member_revision: u64,
    member_overrides: BTreeMap<String, WorkerPoolMemberPolicy>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum UncheckedProvider {
    V1(ProviderV1),
    V2(ProviderV2),
}

/// Validated selection DATA. Only the checked configuration reader constructs
/// this wrapper; serde cannot bypass its version, purpose or policy checks.
pub struct WorkerPoolProvider {
    policy: WorkerPoolPolicy,
    member_overrides: BTreeMap<String, WorkerPoolMemberPolicy>,
    member_revision: u64,
}
impl UncheckedProvider {
    fn checked(self) -> Result<WorkerPoolProvider, PoolPolicyError> {
        let (policy, member_overrides, member_revision) = match self {
            Self::V1(v1) if v1.version == 1 && v1.purpose == PURPOSE => {
                (v1.policy, BTreeMap::new(), 0)
            }
            Self::V2(v2)
                if v2.version == 2 && v2.purpose == EDITABLE_PURPOSE && v2.member_revision > 0 =>
            {
                (v2.policy, v2.member_overrides, v2.member_revision)
            }
            _ => return Err(PoolPolicyError),
        };
        policy.validate()?;
        for (employee, settings) in &member_overrides {
            if birth_member_policy(&policy, employee).is_none_or(|birth| birth == *settings)
                || settings.memory_high_mib() >= policy.memory_max_mi_b
            {
                return Err(PoolPolicyError);
            }
        }
        Ok(WorkerPoolProvider {
            policy,
            member_overrides,
            member_revision,
        })
    }
}

fn provider_key() -> Text {
    Text("workerPoolProvider".chars().map(u32::from).collect())
}

fn birth_member_policy(
    policy: &WorkerPoolPolicy,
    employee: &str,
) -> Option<WorkerPoolMemberPolicy> {
    let high = *policy.employee_memory_high_mi_b.get(employee)?;
    WorkerPoolMemberPolicy::new(high, policy.cpu_weight).ok()
}

impl WorkerPoolProvider {
    pub(super) fn for_replacement(
        config: &EffectiveWorkerConfig,
        policy: &WorkerPoolPolicy,
    ) -> Result<Value, PoolPolicyError> {
        let Some(previous) = Self::from_config(config)?.filter(|old| old.member_revision > 0)
        else {
            return encode_provider(&ProviderV1 {
                version: 1,
                purpose: PURPOSE.to_owned(),
                policy: policy.clone(),
            });
        };
        let mut overrides = BTreeMap::new();
        for (employee, settings) in previous.member_overrides {
            let birth = birth_member_policy(policy, &employee).ok_or(PoolPolicyError)?;
            if settings == birth {
                continue;
            }
            if settings.memory_high_mib() >= policy.memory_max_mi_b {
                return Err(PoolPolicyError);
            }
            overrides.insert(employee, settings);
        }
        encode_provider(&ProviderV2 {
            version: 2,
            purpose: EDITABLE_PURPOSE.to_owned(),
            policy: policy.clone(),
            member_revision: previous.member_revision,
            member_overrides: overrides,
        })
    }

    pub fn from_config(config: &EffectiveWorkerConfig) -> Result<Option<Self>, PoolPolicyError> {
        let Node::Object(root) = &config.as_value().0 else {
            return Err(PoolPolicyError);
        };
        let Some(value) = root.get(&provider_key()) else {
            return Ok(None);
        };
        let provider: UncheckedProvider =
            serde_json::from_slice(&crate::worker_config::compact_data(value))
                .map_err(|_| PoolPolicyError)?;
        provider.checked().map(Some)
    }
    pub fn policy(&self) -> &WorkerPoolPolicy {
        &self.policy
    }

    pub fn member_policy(&self, employee: &str) -> Option<WorkerPoolMemberPolicy> {
        self.member_overrides
            .get(employee)
            .copied()
            .or_else(|| birth_member_policy(&self.policy, employee))
    }

    pub fn member_overrides(&self) -> &BTreeMap<String, WorkerPoolMemberPolicy> {
        &self.member_overrides
    }

    pub fn member_revision(&self) -> u64 {
        self.member_revision
    }

    /// Keep runtime tuning out of immutable worker creation hashes. The
    /// installed provider still carries its complete source revision.
    pub(crate) fn project_birth_fields(
        &self,
        fields: &mut BTreeMap<Text, Value>,
    ) -> Result<(), PoolPolicyError> {
        if self.member_revision > 0 {
            let birth = ProviderV1 {
                version: 1,
                purpose: PURPOSE.to_owned(),
                policy: self.policy.clone(),
            };
            fields.insert(provider_key(), encode_provider(&birth)?);
        }
        Ok(())
    }

    /// Project a single employee's desired settings, preserving the birth
    /// policy, peer settings and original configured SID ordering.
    pub fn project_member_policy(
        config: &EffectiveWorkerConfig,
        employee: &ProfileEmployeeId,
        settings: WorkerPoolMemberPolicy,
    ) -> Result<EffectiveWorkerConfig, PoolPolicyError> {
        let Some(mut provider) = Self::from_config(config)? else {
            return Err(PoolPolicyError);
        };
        let employee = employee.as_str();
        let birth = birth_member_policy(&provider.policy, employee).ok_or(PoolPolicyError)?;
        if provider.member_policy(employee) == Some(settings) {
            return Ok(config.clone());
        }
        if settings != birth && settings.memory_high_mib() >= provider.policy.memory_max_mi_b {
            return Err(PoolPolicyError);
        }
        if settings == birth {
            provider.member_overrides.remove(employee);
        } else {
            provider
                .member_overrides
                .insert(employee.to_owned(), settings);
        }
        let data = ProviderV2 {
            version: 2,
            purpose: EDITABLE_PURPOSE.to_owned(),
            policy: provider.policy,
            member_revision: provider
                .member_revision
                .checked_add(1)
                .ok_or(PoolPolicyError)?,
            member_overrides: provider.member_overrides,
        };
        let mut root = config.clone().into_value();
        let Node::Object(mut fields) = std::mem::replace(&mut root.0, Node::Null) else {
            return Err(PoolPolicyError);
        };
        fields.insert(provider_key(), encode_provider(&data)?);
        config
            .pool_configuration_fields(fields)
            .ok_or(PoolPolicyError)
    }
}

fn encode_provider(data: &impl Serialize) -> Result<Value, PoolPolicyError> {
    let raw = serde_json::to_vec(data).map_err(|_| PoolPolicyError)?;
    legacy_json::decode_utf8(&raw).map_err(|_| PoolPolicyError)
}
