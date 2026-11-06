//! Rootless subordinate-ID arithmetic. These mappings are data, never grants.
use crate::decimal::UnsignedInteger;

#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub struct SubordinateId(UnsignedInteger);
impl SubordinateId {
    pub fn parse(value: &str) -> Option<Self> {
        UnsignedInteger::parse(value).map(Self)
    }
    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }
    pub fn is_zero(&self) -> bool {
        self.0.is_zero()
    }
    fn add(&self, other: &Self) -> Self {
        Self(self.0.plus(&other.0))
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SubordinateRange {
    low: SubordinateId,
    count: SubordinateId,
}
impl SubordinateRange {
    pub fn new(low: SubordinateId, count: SubordinateId) -> Self {
        Self { low, count }
    }
    pub fn low(&self) -> &SubordinateId {
        &self.low
    }
    pub fn count(&self) -> &SubordinateId {
        &self.count
    }
}
pub fn granted(ranges: &[SubordinateRange], start: &SubordinateId, count: &SubordinateId) -> bool {
    !start.is_zero()
        && count_sufficient(count)
        && ranges
            .iter()
            .any(|range| &range.low <= start && start.add(count) <= range.low.add(&range.count))
}
pub fn count_sufficient(count: &SubordinateId) -> bool {
    count >= &SubordinateId(UnsignedInteger::from_u64(65536))
}
