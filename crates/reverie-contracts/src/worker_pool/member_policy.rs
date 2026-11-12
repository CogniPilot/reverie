//! Per-employee reclaim and CPU sharing settings. Hard pool limits and
//! placement are owned by the original pool policy.
use super::{MEMORY_MAX_MIB, PoolPolicyError};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(try_from = "MemberPolicyData")]
pub struct WorkerPoolMemberPolicy {
    #[serde(rename = "memoryHighMiB")]
    memory_high_mib: u32,
    #[serde(rename = "cpuWeight")]
    cpu_weight: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MemberPolicyData {
    #[serde(rename = "memoryHighMiB")]
    memory_high_mib: u32,
    #[serde(rename = "cpuWeight")]
    cpu_weight: u32,
}

impl TryFrom<MemberPolicyData> for WorkerPoolMemberPolicy {
    type Error = PoolPolicyError;

    fn try_from(data: MemberPolicyData) -> Result<Self, Self::Error> {
        Self::new(data.memory_high_mib, data.cpu_weight)
    }
}

impl WorkerPoolMemberPolicy {
    pub fn new(memory_high_mib: u32, cpu_weight: u32) -> Result<Self, PoolPolicyError> {
        if !(1..=MEMORY_MAX_MIB).contains(&memory_high_mib) || !(1..=10_000).contains(&cpu_weight) {
            return Err(PoolPolicyError);
        }
        Ok(Self {
            memory_high_mib,
            cpu_weight,
        })
    }

    pub fn memory_high_mib(self) -> u32 {
        self.memory_high_mib
    }

    pub fn memory_high_bytes(self) -> u64 {
        u64::from(self.memory_high_mib) * 1_048_576
    }

    pub fn cpu_weight(self) -> u32 {
        self.cpu_weight
    }
}
