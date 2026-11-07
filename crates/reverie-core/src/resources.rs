use crate::ValueError;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BudgetMode {
    Admission,
    Pool,
}

/// Encoding provenance matters to the legacy profile digest (1 versus 1.0).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum CpuRepresentation {
    Integer(u8),
    Float(f64),
}

#[derive(Clone, Copy, Debug)]
pub struct CpuQuota(CpuRepresentation);
fn valid_cpu(value: f64) -> bool {
    value.is_finite() && (value == 0.0 || (0.25..=64.0).contains(&value))
}
impl CpuQuota {
    pub fn from_integer(value: u64) -> Result<Self, ValueError> {
        let value = u8::try_from(value).map_err(|_| ValueError::CpuLimit)?;
        if !valid_cpu(f64::from(value)) {
            return Err(ValueError::CpuLimit);
        }
        Ok(Self(CpuRepresentation::Integer(value)))
    }
    pub fn from_float(value: f64) -> Result<Self, ValueError> {
        if !valid_cpu(value) {
            return Err(ValueError::CpuLimit);
        }
        Ok(Self(CpuRepresentation::Float(value)))
    }
    pub fn representation(self) -> CpuRepresentation {
        self.0
    }
    /// Existing Python int(cpus * 1_000_000_000), after this bounded finite
    /// quota check. Integral quota multiplication is exact in this range.
    pub fn nano_cpus(self) -> u64 {
        let value = match self.0 {
            CpuRepresentation::Integer(value) => f64::from(value),
            CpuRepresentation::Float(value) => value,
        };
        (value * 1_000_000_000.0) as u64
    }
}
impl PartialEq for CpuQuota {
    fn eq(&self, other: &Self) -> bool {
        match (self.0, other.0) {
            (CpuRepresentation::Integer(left), CpuRepresentation::Integer(right)) => left == right,
            (CpuRepresentation::Float(left), CpuRepresentation::Float(right)) => {
                left.to_bits() == right.to_bits()
            }
            _ => false,
        }
    }
}
impl Eq for CpuQuota {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PoolLimits {
    memory_mib: u32,
    tasks_max: u32,
}
impl PoolLimits {
    pub fn try_new(memory_mib: u32, tasks_max: u32) -> Result<Self, ValueError> {
        if !(512..=1_048_576).contains(&memory_mib) || !(128..=32768).contains(&tasks_max) {
            return Err(ValueError::ResourceLimit);
        }
        Ok(Self {
            memory_mib,
            tasks_max,
        })
    }
    pub fn memory_mib(self) -> u32 {
        self.memory_mib
    }
    pub fn tasks_max(self) -> u32 {
        self.tasks_max
    }
}

/// Checked six-field configuration data before the reservation pool override.
/// Its local pool may be smaller than memory; only `resolve` yields a policy.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResourceTemplate {
    mode: BudgetMode,
    memory_mib: u32,
    pids_limit: u32,
    cpus: CpuQuota,
    pool: PoolLimits,
}
impl ResourceTemplate {
    pub fn try_new(
        mode: BudgetMode,
        memory_mib: u32,
        pids_limit: u32,
        cpus: CpuQuota,
        pool_memory_mib: u32,
        pool_tasks_max: u32,
    ) -> Result<Self, ValueError> {
        if memory_mib > 1_048_576
            || !(64..=4096).contains(&pids_limit)
            || (mode == BudgetMode::Admission && memory_mib < 512)
        {
            return Err(ValueError::ResourceLimit);
        }
        Ok(Self {
            mode,
            memory_mib,
            pids_limit,
            cpus,
            pool: PoolLimits::try_new(pool_memory_mib, pool_tasks_max)?,
        })
    }
    pub fn resolve(
        &self,
        reservation_pool: Option<PoolLimits>,
    ) -> Result<ResourcePolicy, ValueError> {
        let mut resolved = self.clone();
        if let Some(pool) = reservation_pool {
            resolved.pool = pool;
        }
        if resolved.memory_mib > resolved.pool.memory_mib {
            return Err(ValueError::ResourceLimit);
        }
        Ok(ResourcePolicy(resolved))
    }
    pub fn budget_mode(&self) -> BudgetMode {
        self.mode
    }
    pub fn memory_mib(&self) -> u32 {
        self.memory_mib
    }
    pub fn pids_limit(&self) -> u32 {
        self.pids_limit
    }
    pub fn cpus(&self) -> CpuQuota {
        self.cpus
    }
    pub fn pool_memory_mib(&self) -> u32 {
        self.pool.memory_mib
    }
    pub fn pool_tasks_max(&self) -> u32 {
        self.pool.tasks_max
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResourcePolicy(ResourceTemplate);
impl ResourcePolicy {
    pub fn try_new(
        mode: BudgetMode,
        memory_mib: u32,
        pids_limit: u32,
        cpus: CpuQuota,
        pool_memory_mib: u32,
        pool_tasks_max: u32,
    ) -> Result<Self, ValueError> {
        ResourceTemplate::try_new(
            mode,
            memory_mib,
            pids_limit,
            cpus,
            pool_memory_mib,
            pool_tasks_max,
        )?
        .resolve(None)
    }
    pub fn budget_mode(&self) -> BudgetMode {
        self.0.budget_mode()
    }
    pub fn memory_mib(&self) -> u32 {
        self.0.memory_mib()
    }
    pub fn pids_limit(&self) -> u32 {
        self.0.pids_limit()
    }
    pub fn cpus(&self) -> CpuQuota {
        self.0.cpus()
    }
    pub fn pool_memory_mib(&self) -> u32 {
        self.0.pool_memory_mib()
    }
    pub fn pool_tasks_max(&self) -> u32 {
        self.0.pool_tasks_max()
    }
}
impl From<&ResourcePolicy> for ResourceTemplate {
    fn from(policy: &ResourcePolicy) -> Self {
        policy.0.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn policy_preserves_legacy_mode_specific_limits() {
        let cpu = CpuQuota::from_integer(0).unwrap();
        for memory in [0, 1, 511, 512, 1024] {
            assert!(ResourcePolicy::try_new(BudgetMode::Pool, memory, 64, cpu, 1024, 128).is_ok());
            assert_eq!(
                ResourcePolicy::try_new(BudgetMode::Admission, memory, 64, cpu, 1024, 128).is_ok(),
                memory >= 512
            );
        }
        assert!(ResourcePolicy::try_new(BudgetMode::Pool, 1025, 64, cpu, 1024, 128).is_err());
    }
    #[test]
    fn cpu_values_are_checked_without_losing_encoding_identity() {
        assert_ne!(
            CpuQuota::from_integer(1).unwrap(),
            CpuQuota::from_float(1.0).unwrap()
        );
        assert_ne!(
            CpuQuota::from_float(0.0).unwrap(),
            CpuQuota::from_float(-0.0).unwrap()
        );
        for value in [f64::NAN, f64::INFINITY, -1.0, 0.1, 64.1] {
            assert!(CpuQuota::from_float(value).is_err());
        }
        assert!(CpuQuota::from_float(0.25).is_ok());
    }
}
