//! Python `int`/`float` semantics for JSON numbers in named compatibility
//! readers: `type(x) in (int, float)` (booleans excluded), int-preserving
//! integer arithmetic, true division, and exact mixed int/float ordering.
//! Integers outside i128 are refused by `of`; callers document that edge.
use crate::legacy_json::{Node, Number, Value};
use std::cmp::Ordering;

#[derive(Clone, Copy, Debug)]
pub(crate) enum PythonNumber {
    Int(i128),
    Float(f64),
}

impl PythonNumber {
    pub(crate) fn of(value: &Value) -> Option<Self> {
        match &value.0 {
            Node::Number(Number::Integer(digits)) => digits.parse().ok().map(Self::Int),
            Node::Number(Number::Float(value)) => Some(Self::Float(*value)),
            Node::Number(Number::Nan) => Some(Self::Float(f64::NAN)),
            Node::Number(Number::PositiveInfinity) => Some(Self::Float(f64::INFINITY)),
            Node::Number(Number::NegativeInfinity) => Some(Self::Float(f64::NEG_INFINITY)),
            _ => None,
        }
    }
    /// Python's int-to-float conversion also rounds to nearest, ties even.
    #[allow(clippy::cast_precision_loss)]
    pub(crate) fn float(self) -> f64 {
        match self {
            Self::Int(value) => value as f64,
            Self::Float(value) => value,
        }
    }
    pub(crate) fn is_finite(self) -> bool {
        matches!(self, Self::Int(_)) || self.float().is_finite()
    }
    pub(crate) fn plus(self, other: Self) -> Option<Self> {
        match (self, other) {
            (Self::Int(left), Self::Int(right)) => left.checked_add(right).map(Self::Int),
            _ => Some(Self::Float(self.float() + other.float())),
        }
    }
    pub(crate) fn times(self, other: Self) -> Option<Self> {
        match (self, other) {
            (Self::Int(left), Self::Int(right)) => left.checked_mul(right).map(Self::Int),
            _ => Some(Self::Float(self.float() * other.float())),
        }
    }
    /// `/` (true division) by a nonzero integer count.
    pub(crate) fn divided_by(self, count: i128) -> f64 {
        #[allow(clippy::cast_precision_loss)]
        match self {
            // Python's int / int is correctly rounded; the sums here are far
            // below 2^53, where the float quotient is exact to one rounding.
            Self::Int(value) => value as f64 / count as f64,
            Self::Float(value) => value / count as f64,
        }
    }
    /// Python's exact mixed int/float ordering; `None` for NaN.
    pub(crate) fn compare(self, other: Self) -> Option<Ordering> {
        match (self, other) {
            (Self::Int(left), Self::Int(right)) => Some(left.cmp(&right)),
            (Self::Float(left), Self::Float(right)) => left.partial_cmp(&right),
            (Self::Int(left), Self::Float(right)) => int_float(left, right),
            (Self::Float(left), Self::Int(right)) => int_float(right, left).map(Ordering::reverse),
        }
    }
    pub(crate) fn le(self, other: Self) -> bool {
        matches!(self.compare(other), Some(Ordering::Less | Ordering::Equal))
    }
    pub(crate) fn lt(self, other: Self) -> bool {
        matches!(self.compare(other), Some(Ordering::Less))
    }
}

/// Python's `round(x, digits)`: the double nearest the correctly rounded
/// decimal. Rust's fixed-precision formatting also breaks exact ties to even.
pub(crate) fn round(value: f64, digits: usize) -> f64 {
    format!("{value:.digits$}").parse().unwrap_or(value)
}

#[allow(clippy::cast_possible_truncation, clippy::float_cmp)]
fn int_float(integer: i128, float: f64) -> Option<Ordering> {
    const LIMIT: f64 = 170_141_183_460_469_231_731_687_303_715_884_105_728.0; // 2^127
    if float.is_nan() {
        return None;
    }
    if float >= LIMIT {
        return Some(Ordering::Less);
    }
    if float < -LIMIT {
        return Some(Ordering::Greater);
    }
    let whole = float.trunc();
    Some(integer.cmp(&(whole as i128)).then(if float > whole {
        Ordering::Less
    } else if float < whole {
        Ordering::Greater
    } else {
        Ordering::Equal
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mixed_comparison_and_arithmetic_follow_python() {
        let (int, float) = (PythonNumber::Int, PythonNumber::Float);
        assert!(int(12).le(float(12.0)) && !int(12).lt(float(12.0)));
        assert!(int(-3).lt(float(-2.5)) && float(2.5).lt(int(3)));
        assert!(
            int(9_007_199_254_740_993).compare(float(9_007_199_254_740_992.0))
                == Some(Ordering::Greater)
        );
        assert!(int(1).compare(float(f64::NAN)).is_none());
        assert!(matches!(int(3).times(int(4)), Some(PythonNumber::Int(12))));
        assert!(
            matches!(int(3).times(float(0.5)), Some(PythonNumber::Float(value)) if value == 1.5)
        );
        assert_eq!(int(7).divided_by(2), 3.5);
    }
}
