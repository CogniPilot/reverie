//! Deferred PyYAML integer construction for selected report values. Validation
//! of every scalar still occurs in the original whole-document constructor.
use super::*;
use reverie_core::{decimal::UnsignedInteger, python_numeric_text, python_trim_text};

struct Signed {
    negative: bool,
    magnitude: UnsignedInteger,
}
impl Signed {
    fn add(self, other: Self) -> Self {
        if self.negative == other.negative {
            Self {
                negative: self.negative,
                magnitude: self.magnitude.plus(&other.magnitude),
            }
        } else if self.magnitude >= other.magnitude {
            Self {
                negative: self.negative,
                magnitude: self
                    .magnitude
                    .minus(&other.magnitude)
                    .expect("ordered subtraction"),
            }
        } else {
            Self {
                negative: other.negative,
                magnitude: other
                    .magnitude
                    .minus(&self.magnitude)
                    .expect("ordered subtraction"),
            }
        }
    }
}
pub(in crate::gpu_access::cdi) fn integer_value(raw: &str) -> Result<String> {
    let raw = raw.replace('_', "");
    let negative = raw.starts_with('-');
    let value = raw.strip_prefix(['+', '-']).unwrap_or(&raw);
    let mut parsed = if value == "0" {
        parse("0", 10)?
    } else if let Some(value) = value.strip_prefix("0b") {
        parse(value, 2)?
    } else if let Some(value) = value.strip_prefix("0x") {
        parse(value, 16)?
    } else if value.starts_with('0') {
        parse(value, 8)?
    } else if value.contains(':') {
        let mut sum = parse("0", 10)?;
        for part in value.split(':') {
            sum.magnitude = sum.magnitude.times(60);
            sum = sum.add(parse(part, 10)?);
        }
        sum
    } else {
        parse(value, 10)?
    };
    parsed.negative ^= negative;
    // Python's decimal json.dumps conversion bound applies at report time,
    // including an arbitrarily long base-two/base-sixteen source integer.
    if parsed.magnitude.as_str().len() > legacy_json::DEFAULT_INT_MAX_DIGITS {
        return Err(GpuDataError::CdiDocument);
    }
    Ok(format!(
        "{}{}",
        if parsed.negative && !parsed.magnitude.is_zero() {
            "-"
        } else {
            ""
        },
        parsed.magnitude.as_str()
    ))
}
fn parse(raw: &str, base: u32) -> Result<Signed> {
    let normalized = python_numeric_text(raw).ok_or(GpuDataError::CdiDocument)?;
    let value = python_trim_text(&normalized);
    let negative = value.starts_with('-');
    let value = value.strip_prefix(['+', '-']).unwrap_or(value);
    let prefixes = match base {
        2 => ["0b", "0B"],
        8 => ["0o", "0O"],
        16 => ["0x", "0X"],
        _ => ["", ""],
    };
    let value = if base == 10 {
        value
    } else {
        value
            .strip_prefix(prefixes[0])
            .or_else(|| value.strip_prefix(prefixes[1]))
            .unwrap_or(value)
    };
    if value.is_empty() {
        return Err(GpuDataError::CdiDocument);
    }
    let mut magnitude = UnsignedInteger::from_u64(0);
    for point in value.chars() {
        let digit = point.to_digit(base).ok_or(GpuDataError::CdiDocument)?;
        magnitude = magnitude
            .times(base)
            .plus(&UnsignedInteger::from_u64(u64::from(digit)));
    }
    Ok(Signed {
        negative,
        magnitude,
    })
}
