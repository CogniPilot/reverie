//! Checked device/soft-memory policy data. These values confer no host authority.
mod gpu;
mod memory;
pub use gpu::{GpuEmployeeGrants, GpuPolicies, GpuSessionGrants, MAX_GPU_GRANTS, NvidiaCdiDevice};
pub use memory::{
    MAX_MEMORY_POLICIES, MAX_SWAP_POOL_MIB, MemoryPolicies, ProjectedMemoryPolicy, SoftMemoryPolicy,
};
use std::fmt;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DevicePolicyError {
    GpuDevice,
    GpuCount,
    MemoryCount,
    MemoryPolicy,
    SwapPool,
    EffectiveCeiling,
    MemoryHigh,
}
impl DevicePolicyError {
    pub fn code(self) -> &'static str {
        match self {
            Self::GpuDevice => "PHYSICAL_NVIDIA_CDI_DEVICE",
            Self::GpuCount => "GPU_GRANT_COUNT",
            Self::MemoryCount => "EMPLOYEE_MEMORY_POLICY_COUNT",
            Self::MemoryPolicy => "EMPLOYEE_MEMORY_POLICY",
            Self::SwapPool => "LAPTOP_SWAP_POOL",
            Self::EffectiveCeiling => "CHECKED_EFFECTIVE_RAM_REQUIRED",
            Self::MemoryHigh => "SOFT_MEMORY_FINITE_CEILING",
        }
    }
}
impl fmt::Display for DevicePolicyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}
impl std::error::Error for DevicePolicyError {}
