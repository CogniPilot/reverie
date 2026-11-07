use super::DevicePolicyError;
use crate::ids::ProfileEmployeeId;
use crate::resources::ResourcePolicy;
use std::collections::BTreeMap;

pub const MAX_MEMORY_POLICIES: usize = crate::profiles::MAX_PROFILES;
pub const MAX_SWAP_POOL_MIB: u32 = 1_048_576;
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SoftMemoryPolicy {
    high: Option<u32>,
    swap: u32,
}
impl SoftMemoryPolicy {
    pub fn try_new(high: Option<u32>, swap: u32) -> Result<Self, DevicePolicyError> {
        if high.is_some_and(|value| !(512..=1_048_576).contains(&value)) || swap > MAX_SWAP_POOL_MIB
        {
            return Err(DevicePolicyError::MemoryPolicy);
        }
        Ok(Self { high, swap })
    }
    pub fn memory_high_mib(&self) -> Option<u32> {
        self.high
    }
    pub fn swap_mib(&self) -> u32 {
        self.swap
    }
    /// Checked projection DATA, including a frozen session policy. No native
    /// cgroup observation, admission or permission to write follows.
    pub fn project(
        &self,
        pool: u32,
        effective: Option<&ResourcePolicy>,
    ) -> Result<ProjectedMemoryPolicy, DevicePolicyError> {
        if pool > MAX_SWAP_POOL_MIB || self.swap > pool {
            return Err(DevicePolicyError::SwapPool);
        }
        if let Some(high) = self.high {
            let ceiling = effective
                .ok_or(DevicePolicyError::EffectiveCeiling)?
                .memory_mib();
            if high >= ceiling {
                return Err(DevicePolicyError::MemoryHigh);
            }
        }
        Ok(ProjectedMemoryPolicy {
            policy: self.clone(),
            pool,
        })
    }
}
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct MemoryPolicies {
    policies: BTreeMap<ProfileEmployeeId, SoftMemoryPolicy>,
    pool: u32,
}
impl MemoryPolicies {
    pub fn try_new(
        policies: BTreeMap<ProfileEmployeeId, SoftMemoryPolicy>,
        pool: u32,
    ) -> Result<Self, DevicePolicyError> {
        if policies.len() > MAX_MEMORY_POLICIES {
            return Err(DevicePolicyError::MemoryCount);
        }
        if pool > MAX_SWAP_POOL_MIB || policies.values().any(|policy| policy.swap > pool) {
            return Err(DevicePolicyError::SwapPool);
        }
        Ok(Self { policies, pool })
    }
    pub fn policies(&self) -> &BTreeMap<ProfileEmployeeId, SoftMemoryPolicy> {
        &self.policies
    }
    pub fn swap_pool_mib(&self) -> u32 {
        self.pool
    }
    pub fn selected(&self, employee: Option<&ProfileEmployeeId>) -> Option<&SoftMemoryPolicy> {
        employee.and_then(|employee| self.policies.get(employee))
    }
    /// The selected high threshold requires the actual checked effective policy;
    /// no ceiling data is inspected for unselected or swap-only policies.
    pub fn project(
        &self,
        employee: Option<&ProfileEmployeeId>,
        effective: Option<&ResourcePolicy>,
    ) -> Result<Option<ProjectedMemoryPolicy>, DevicePolicyError> {
        let Some(policy) = self.selected(employee) else {
            return Ok(None);
        };
        policy.project(self.pool, effective).map(Some)
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectedMemoryPolicy {
    policy: SoftMemoryPolicy,
    pool: u32,
}
impl ProjectedMemoryPolicy {
    pub fn policy(&self) -> &SoftMemoryPolicy {
        &self.policy
    }
    pub fn swap_pool_mib(&self) -> u32 {
        self.pool
    }
    /// Checked finite commitment data, not an admission/disk reservation proof.
    pub fn swap_bytes(&self) -> u64 {
        u64::from(self.policy.swap) * 1_048_576
    }
}
