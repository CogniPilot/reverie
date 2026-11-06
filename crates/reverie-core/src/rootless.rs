//! Rootless subordinate-ID arithmetic. These mappings are data, never grants.
use std::cmp::Ordering;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SubordinateId(String);
impl SubordinateId {
    pub fn parse(value: &str) -> Option<Self> {
        if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let normalized = value.trim_start_matches('0');
        Some(Self(if normalized.is_empty() {
            "0".into()
        } else {
            normalized.into()
        }))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
    pub fn is_zero(&self) -> bool {
        self.0 == "0"
    }
    fn add(&self, other: &Self) -> Self {
        let mut result = Vec::new();
        let mut left = self.0.bytes().rev();
        let mut right = other.0.bytes().rev();
        let mut carry = 0;
        loop {
            let a = left.next();
            let b = right.next();
            if a.is_none() && b.is_none() && carry == 0 {
                break;
            }
            let value = a.map_or(0, |v| v - b'0') + b.map_or(0, |v| v - b'0') + carry;
            result.push(b'0' + value % 10);
            carry = value / 10;
        }
        result.reverse();
        Self(String::from_utf8(result).expect("decimal digits"))
    }
}
impl Ord for SubordinateId {
    fn cmp(&self, other: &Self) -> Ordering {
        self.0
            .len()
            .cmp(&other.0.len())
            .then_with(|| self.0.cmp(&other.0))
    }
}
impl PartialOrd for SubordinateId {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
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
    count >= &SubordinateId("65536".into())
}
