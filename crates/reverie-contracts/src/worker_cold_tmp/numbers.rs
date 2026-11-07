//! Keep integer timestamp arithmetic until the actual mixed-float boundary.
use super::*;
use crate::legacy_json::Number;
use reverie_core::decimal::UnsignedInteger;
use std::cmp::Ordering;
pub(super) struct Timestamp<'a>(&'a Number);
impl<'a> Timestamp<'a> {
    pub(super) fn capture(value: Option<&'a Value>) -> Option<Self> {
        match value {
            Some(Value(Node::Number(number))) => Some(Self(number)),
            _ => None,
        }
    }
    pub(super) fn valid_window(&self, until: &Self) -> Result<bool> {
        if let (Number::Integer(created), Number::Integer(until)) = (self.0, until.0) {
            if compare_integer(until, created) != Ordering::Greater {
                return Ok(false);
            }
            let (cn, created) = integer(created);
            let (un, until) = integer(until);
            let difference = if cn != un {
                created.plus(&until)
            } else if cn {
                created.minus(&until).expect("ordered negatives")
            } else {
                until.minus(&created).expect("ordered positives")
            };
            return Ok(difference <= UnsignedInteger::from_u64(86400));
        }
        let difference = until.float()? - self.float()?;
        Ok(difference > 0.0 && difference <= 86400.0)
    }
    pub(super) fn no_later_than(&self, bound: f64) -> bool {
        match self.0 {
            Number::Integer(value) => integer_le_float(value, bound),
            _ => self.float().is_ok_and(|value| value <= bound),
        }
    }
    pub(super) fn close_enough_to(&self, now: f64) -> Result<bool> {
        Ok(self.float()? - now <= 86400.0)
    }
    fn float(&self) -> Result<f64> {
        Ok(match self.0 {
            Number::Integer(text) => {
                let value = text
                    .parse::<f64>()
                    .map_err(|_| ColdDataError::Reservation)?;
                if !value.is_finite() {
                    return Err(ColdDataError::Reservation);
                }
                value
            }
            Number::Float(value) => *value,
            Number::Nan => f64::NAN,
            Number::PositiveInfinity => f64::INFINITY,
            Number::NegativeInfinity => f64::NEG_INFINITY,
        })
    }
}
fn integer(value: &str) -> (bool, UnsignedInteger) {
    let negative = value.starts_with('-');
    let value =
        UnsignedInteger::parse(value.trim_start_matches('-')).expect("decoded JSON integer");
    (negative && !value.is_zero(), value)
}
fn compare_integer(left: &str, right: &str) -> Ordering {
    let (ln, left) = integer(left);
    let (rn, right) = integer(right);
    match (ln, rn) {
        (true, false) => Ordering::Less,
        (false, true) => Ordering::Greater,
        (true, true) => right.cmp(&left),
        (false, false) => left.cmp(&right),
    }
}
fn integer_le_float(value: &str, bound: f64) -> bool {
    if bound.is_nan() {
        return false;
    }
    if bound.is_infinite() {
        return bound.is_sign_positive();
    }
    // Fixed precision zero renders an integral binary64's exact decimal
    // integer, including values beyond the 53-bit safe range.
    let integral = format!("{:.0}", bound.trunc());
    match compare_integer(value, &integral) {
        Ordering::Less => true,
        Ordering::Greater => false,
        Ordering::Equal => bound.fract() >= 0.0,
    }
}
