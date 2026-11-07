//! Exact nonnegative integer arithmetic for checked domain owners. No schema,
//! observation or authority is implied; each caller retains its own bounds.
use std::{cmp::Ordering, num::NonZeroU32};
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UnsignedInteger(String);
impl UnsignedInteger {
    pub fn parse(value: &str) -> Option<Self> {
        if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let value = value.trim_start_matches('0');
        Some(Self(if value.is_empty() {
            "0".into()
        } else {
            value.into()
        }))
    }
    pub fn from_u64(value: u64) -> Self {
        Self(value.to_string())
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
    pub fn is_zero(&self) -> bool {
        self.0 == "0"
    }
    pub fn to_u64(&self) -> Option<u64> {
        self.0.parse().ok()
    }
    pub fn plus(&self, other: &Self) -> Self {
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
            let digit = a.map_or(0, |v| v - b'0') + b.map_or(0, |v| v - b'0') + carry;
            result.push(b'0' + digit % 10);
            carry = digit / 10;
        }
        result.reverse();
        Self(String::from_utf8(result).expect("decimal digits"))
    }
    pub fn times(&self, multiplier: u32) -> Self {
        if multiplier == 0 {
            return Self::from_u64(0);
        }
        let mut result = Vec::new();
        let mut carry = 0u64;
        for digit in self.0.bytes().rev() {
            let value = u64::from(digit - b'0') * u64::from(multiplier) + carry;
            result.push(b'0' + (value % 10) as u8);
            carry = value / 10;
        }
        while carry > 0 {
            result.push(b'0' + (carry % 10) as u8);
            carry /= 10;
        }
        result.reverse();
        Self(String::from_utf8(result).expect("decimal digits"))
    }
    pub fn minus(&self, other: &Self) -> Option<Self> {
        if self < other {
            return None;
        }
        let mut right = other.0.bytes().rev();
        let mut result = Vec::new();
        let mut borrow = 0i16;
        for digit in self.0.bytes().rev() {
            let mut digit = i16::from(digit - b'0')
                - borrow
                - i16::from(right.next().map_or(0, |value| value - b'0'));
            if digit < 0 {
                digit += 10;
                borrow = 1;
            } else {
                borrow = 0;
            }
            result.push(b'0' + digit as u8);
        }
        result.reverse();
        Self::parse(std::str::from_utf8(&result).expect("decimal digits"))
    }
    pub fn remainder(&self, divisor: NonZeroU32) -> u32 {
        self.0.bytes().fold(0u64, |value, digit| {
            (value * 10 + u64::from(digit - b'0')) % u64::from(divisor.get())
        }) as u32
    }
}
impl Ord for UnsignedInteger {
    fn cmp(&self, other: &Self) -> Ordering {
        self.0
            .len()
            .cmp(&other.0.len())
            .then_with(|| self.0.cmp(&other.0))
    }
}
impl PartialOrd for UnsignedInteger {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
