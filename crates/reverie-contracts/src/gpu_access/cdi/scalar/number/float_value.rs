//! PyYAML's float constructor, including reverse sexagesimal summation and
//! checked conversion of each exact integer multiplier to binary64.
use super::*;
use reverie_core::decimal::UnsignedInteger;

pub(in crate::gpu_access::cdi::scalar) fn float_value(raw: &str) -> Option<f64> {
    let normalized = scalar_number(raw)?.to_ascii_lowercase();
    let sign = if normalized.starts_with('-') {
        -1.0
    } else {
        1.0
    };
    let value = normalized.strip_prefix(['+', '-']).unwrap_or(&normalized);
    if value == ".inf" {
        return Some(sign * f64::INFINITY);
    }
    if value == ".nan" {
        return Some(f64::NAN);
    }
    if !value.contains(':') {
        return trim_text(value)
            .parse::<f64>()
            .ok()
            .map(|value| sign * value);
    }
    let mut base = UnsignedInteger::from_u64(1);
    let mut sum = 0.0;
    for part in value.split(':').rev() {
        let digit = trim_text(part).parse::<f64>().ok()?;
        let multiplier = base.as_str().parse::<f64>().ok()?;
        // int->float raises OverflowError even for a zero/NaN digit. This is
        // a whole-document constructor refusal, including ignored scalars.
        if !multiplier.is_finite() {
            return None;
        }
        sum += digit * multiplier;
        base = base.times(60);
    }
    Some(sign * sum)
}
