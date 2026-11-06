//! Complete worker_capacity_policy arithmetic. Facts are supplied data, never
//! qualified observations, admission approval, reservation credit or authority.
use crate::decimal::UnsignedInteger;
use std::fmt;
pub const MAX_COUNTER: u64 = i64::MAX as u64;
pub const GIB: u64 = 1 << 30;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CapacityCounter(u64);
impl CapacityCounter {
    pub fn try_new(value: u64) -> Result<Self, CapacityError> {
        if value > MAX_COUNTER {
            return Err(CapacityError::IntegerFact);
        }
        Ok(Self(value))
    }
    pub fn from_integer(value: &UnsignedInteger) -> Result<Self, CapacityError> {
        Self::try_new(value.to_u64().ok_or(CapacityError::IntegerFact)?)
    }
    pub fn get(self) -> u64 {
        self.0
    }
    fn positive(self) -> Result<(), CapacityError> {
        if self.0 == 0 {
            Err(CapacityError::IntegerFact)
        } else {
            Ok(())
        }
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CapacityError {
    IntegerFact,
    InconsistentHostFacts,
    LegacyFloatOverflow,
}
impl CapacityError {
    pub fn code(self) -> &'static str {
        match self {
            Self::IntegerFact => "CAPACITY_INTEGER_FACT_REQUIRED",
            Self::InconsistentHostFacts => "CAPACITY_HOST_FACTS_INCONSISTENT",
            Self::LegacyFloatOverflow => "CAPACITY_LEGACY_FLOAT_OVERFLOW",
        }
    }
}
impl fmt::Display for CapacityError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(self.code())
    }
}
impl std::error::Error for CapacityError {}
pub fn explicit_host_headroom_fits(
    pool: CapacityCounter,
    site: CapacityCounter,
    reserve: CapacityCounter,
    total: CapacityCounter,
    available: CapacityCounter,
) -> Result<bool, CapacityError> {
    for value in [pool, site, reserve, total] {
        value.positive()?;
    }
    if available.0 > total.0 {
        return Err(CapacityError::InconsistentHostFacts);
    }
    Ok(
        u128::from(pool.0) + u128::from(site.0) + u128::from(reserve.0) <= u128::from(total.0)
            && available.0 >= reserve.0,
    )
}
pub fn pool_headroom_fits(
    budget: CapacityCounter,
    committed: CapacityCounter,
    retained: CapacityCounter,
    candidate: CapacityCounter,
) -> Result<bool, CapacityError> {
    budget.positive()?;
    Ok(
        u128::from(committed.0) + u128::from(retained.0) + u128::from(candidate.0)
            <= u128::from(budget.0),
    )
}
/// Preserve Python's int + 8GiB <= int * .9, including float rounding and its
/// overflow refusal. This legacy rule deliberately has no explicit-counter cap.
pub fn legacy_headroom_fits(
    worker: &UnsignedInteger,
    total: &UnsignedInteger,
) -> Result<bool, CapacityError> {
    if total.is_zero() {
        return Ok(false);
    }
    let total_float = total
        .as_str()
        .parse::<f64>()
        .map_err(|_| CapacityError::LegacyFloatOverflow)?;
    if !total_float.is_finite() {
        return Err(CapacityError::LegacyFloatOverflow);
    }
    let ceiling = UnsignedInteger::parse(&format!("{:.0}", (total_float * 0.9).floor()))
        .expect("nonnegative finite decimal");
    Ok(worker.plus(&UnsignedInteger::from_u64(8 * GIB)) <= ceiling)
}
