//! Closed Docker worker-pool configuration. These values are data, never an
//! installed-controller, maintenance, admission or kernel-readback capability.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
mod controller_v2;
mod engine;
pub use controller_v2::SERVICE_PURPOSE as CONTROLLER_SERVICE_V2_PURPOSE;
pub use controller_v2::{BrokerBirthData, BrokerProgramData, ControllerBirthV2};
pub use engine::validate_anchor_inspection;
pub use engine::{
    validate_controller_inspection, validate_controller_service_v2_inspection,
    validate_engine_information, website_process_data,
};

pub const PURPOSE: &str = "reverie-docker-worker-pool-v1";
pub const MEMORY_MAX_MIB: u32 = 49_152;
pub const TASKS_MAX: u32 = 8192;
/// Fixed controller contribution OUTSIDE the employee worker parent.
pub const CONTROLLER_MEMORY_BYTES: u64 = 256 * 1_048_576;
pub const CONTROLLER_TASKS_MAX: u32 = 128;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkerPoolPolicy {
    pub version: u32,
    pub purpose: String,
    pub deployment: String,
    pub instance_root: String,
    pub engine_id: String,
    pub anchor_image: String,
    pub controller_image: String,
    pub website_container: String,
    pub broker_uid: u32,
    pub broker_gid: u32,
    pub memory_max_mi_b: u32,
    pub pool_tasks_max: u32,
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
            && instance_root(&self.instance_root)
            && uuid(&self.engine_id)
            && self
                .anchor_image
                .strip_prefix("sha256:")
                .is_some_and(hex_id)
            && self
                .controller_image
                .strip_prefix("sha256:")
                .is_some_and(hex_id)
            && hex_id(&self.website_container)
            && self.broker_uid > 0
            && self.broker_gid > 0
            && self.memory_max_mi_b == MEMORY_MAX_MIB
            && self.pool_tasks_max == TASKS_MAX
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

    /// Preserve the registered parent's R-domain spelling. Actual systemd
    /// placement expands dashes into an anchored hierarchy; this is only data.
    pub fn parent_slice(&self) -> String {
        format!("{}-workers.slice", self.deployment)
    }
    pub fn parent_components(&self) -> Vec<String> {
        let mut prefix = String::new();
        let mut parts = Vec::new();
        for part in self.deployment.split('-').chain(std::iter::once("workers")) {
            if !prefix.is_empty() {
                prefix.push('-');
            }
            prefix.push_str(part);
            parts.push(format!("{prefix}.slice"));
        }
        parts
    }
    pub fn parent_cgroup_relative(&self) -> String {
        self.parent_components().join("/")
    }

    pub fn anchor_name(&self) -> String {
        format!("{}-pool-anchor", self.deployment)
    }
    pub fn controller_name(&self) -> String {
        format!("{}-resource-controller", self.deployment)
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
        && !value.ends_with('-')
        && !value.contains("--")
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
fn instance_root(value: &str) -> bool {
    value.len() <= 4096
        && value.starts_with('/')
        && value.ends_with("/reverie")
        && !value.contains('\0')
        && value
            .split('/')
            .skip(1)
            .all(|part| !part.is_empty() && part != "." && part != "..")
}
impl std::error::Error for PoolPolicyError {}

#[cfg(test)]
mod tests {
    mod provider;
    use super::*;

    pub(super) fn policy() -> WorkerPoolPolicy {
        WorkerPoolPolicy {
            version: 1,
            purpose: PURPOSE.into(),
            deployment: "owned-fixture".into(),
            instance_root: "/home/fixture/reverie".into(),
            engine_id: "11111111-1111-4111-8111-111111111111".into(),
            anchor_image: format!("sha256:{}", "a".repeat(64)),
            controller_image: format!("sha256:{}", "c".repeat(64)),
            website_container: "b".repeat(64),
            broker_uid: 1000,
            broker_gid: 100,
            memory_max_mi_b: MEMORY_MAX_MIB,
            pool_tasks_max: TASKS_MAX,
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
        assert_eq!(original.parent_slice(), "owned-fixture-workers.slice");
        assert_eq!(
            original.parent_cgroup_relative(),
            "owned.slice/owned-fixture.slice/owned-fixture-workers.slice"
        );
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

    #[test]
    fn version_one_preserves_finite_soft_threshold_at_the_hard_ceiling() {
        for (high, accepted) in [
            (0, false),
            (1, true),
            (49_151, true),
            (49_152, true),
            (49_153, false),
        ] {
            let mut selected = policy();
            *selected
                .employee_memory_high_mi_b
                .values_mut()
                .next()
                .unwrap() = high;
            assert_eq!(selected.validate().is_ok(), accepted);
        }
    }
}
