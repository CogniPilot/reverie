//! Closed Docker worker-pool configuration. These values are data, never an
//! installed-controller, maintenance, admission or kernel-readback capability.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub const PURPOSE: &str = "reverie-docker-worker-pool-v1";
pub const MEMORY_MAX_MIB: u32 = 49_152;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkerPoolPolicy {
    pub version: u32,
    pub purpose: String,
    pub deployment: String,
    pub engine_id: String,
    pub anchor_image: String,
    pub website_container: String,
    pub broker_uid: u32,
    pub memory_max_mi_b: u32,
    pub cpu_weight: u32,
    pub allowed_cpus: Vec<u32>,
    pub employee_memory_high_mi_b: BTreeMap<String, u32>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PoolPolicyError;

impl WorkerPoolPolicy {
    pub fn decode(raw: &[u8]) -> Result<Self, PoolPolicyError> {
        if raw.is_empty() || raw.len() > 65_536 {
            return Err(PoolPolicyError);
        }
        let value: Self = serde_json::from_slice(raw).map_err(|_| PoolPolicyError)?;
        value.validate()?;
        Ok(value)
    }

    pub fn validate(&self) -> Result<(), PoolPolicyError> {
        let valid = self.version == 1
            && self.purpose == PURPOSE
            && identifier(&self.deployment)
            && uuid(&self.engine_id)
            && self
                .anchor_image
                .strip_prefix("sha256:")
                .is_some_and(hex_id)
            && hex_id(&self.website_container)
            && self.broker_uid > 0
            && self.memory_max_mi_b == MEMORY_MAX_MIB
            && (1..=10_000).contains(&self.cpu_weight)
            && !self.allowed_cpus.is_empty()
            && self.allowed_cpus.len() <= 4096
            && self.allowed_cpus.iter().all(|cpu| *cpu < 4096)
            && self.allowed_cpus.windows(2).all(|pair| pair[0] < pair[1])
            && !self.employee_memory_high_mi_b.is_empty()
            && self.employee_memory_high_mi_b.len() <= 256
            && self
                .employee_memory_high_mi_b
                .iter()
                .all(|(employee, high)| uuid(employee) && (1..=MEMORY_MAX_MIB).contains(high));
        valid.then_some(()).ok_or(PoolPolicyError)
    }

    /// Stable, hierarchy-safe name derived from the actual deployment identity.
    /// Policy changes preserve the same parent instead of creating a second pool.
    pub fn parent_slice(&self) -> String {
        let digest = Sha256::digest(self.deployment.as_bytes());
        let suffix: String = digest[..12]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        format!("reverieworkers{suffix}.slice")
    }

    pub fn anchor_name(&self) -> String {
        format!("{}-pool-anchor", self.deployment)
    }

    pub fn cpu_list(&self) -> String {
        self.allowed_cpus
            .iter()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join(",")
    }
}

pub fn hex_id(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn identifier(value: &str) -> bool {
    (1..=40).contains(&value.len())
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
            }
        })
        && value
            .bytes()
            .any(|byte| (b'1'..=b'9').contains(&byte) || (b'a'..=b'f').contains(&byte))
}

impl std::fmt::Display for PoolPolicyError {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        output.write_str("WORKER_POOL_POLICY_INVALID")
    }
}
impl std::error::Error for PoolPolicyError {}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> WorkerPoolPolicy {
        WorkerPoolPolicy {
            version: 1,
            purpose: PURPOSE.into(),
            deployment: "owned-fixture".into(),
            engine_id: "11111111-1111-4111-8111-111111111111".into(),
            anchor_image: format!("sha256:{}", "a".repeat(64)),
            website_container: "b".repeat(64),
            broker_uid: 1000,
            memory_max_mi_b: MEMORY_MAX_MIB,
            cpu_weight: 100,
            allowed_cpus: vec![0, 1],
            employee_memory_high_mi_b: BTreeMap::from([(
                "22222222-2222-4222-8222-222222222222".into(),
                1536,
            )]),
        }
    }

    #[test]
    fn fixed_pool_contract_preserves_soft_allocations_and_stable_parent() {
        let original = policy();
        let raw = serde_json::to_vec(&original).unwrap();
        assert_eq!(WorkerPoolPolicy::decode(&raw).unwrap(), original);
        let mut changed = original.clone();
        changed.cpu_weight = 200;
        *changed
            .employee_memory_high_mi_b
            .values_mut()
            .next()
            .unwrap() = 2048;
        assert_eq!(changed.parent_slice(), original.parent_slice());
        changed.deployment = "another-fixture".into();
        assert_ne!(changed.parent_slice(), original.parent_slice());
        assert!(!original.parent_slice().contains('-'));
        assert_eq!(original.cpu_list(), "0,1");
    }

    #[test]
    fn paths_commands_optional_authority_and_invalid_hard_limits_refuse() {
        let original = serde_json::to_value(policy()).unwrap();
        for field in [
            "cgroupParent",
            "engineSocket",
            "command",
            "available",
            "maintenanceHeld",
        ] {
            let mut changed = original.clone();
            changed[field] = serde_json::json!("caller-selected");
            assert!(WorkerPoolPolicy::decode(&serde_json::to_vec(&changed).unwrap()).is_err());
        }
        for max in [0, 1536, 65_536] {
            let mut changed = policy();
            changed.memory_max_mi_b = max;
            assert!(changed.validate().is_err());
        }
        for cpus in [vec![], vec![1, 0], vec![0, 0], vec![4096]] {
            let mut changed = policy();
            changed.allowed_cpus = cpus;
            assert!(changed.validate().is_err());
        }
    }
}
