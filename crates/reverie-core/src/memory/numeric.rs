//! Python 3.13 real-valued memory arithmetic. Non-real complex results are
//! explicitly refused by the typed f64/JSON score boundary.
use std::fmt;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MemoryMathError {
    ZeroDivision,
    Domain,
    Overflow,
}
impl fmt::Display for MemoryMathError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for MemoryMathError {}

// CPython 3.13 builtin_sum's Neumaier compensation, including its finite
// correction guard. Ordinary Iterator::sum changes persisted embedding bytes.
pub(super) fn python_sum(values: impl IntoIterator<Item = f64>) -> f64 {
    let mut total = 0.0_f64;
    let mut correction = 0.0_f64;
    for value in values {
        let next = total + value;
        correction += if total.abs() >= value.abs() {
            (total - next) + value
        } else {
            (value - next) + total
        };
        total = next;
    }
    if correction != 0.0 && correction.is_finite() {
        total += correction;
    }
    total
}
pub(super) fn python_pow(base: f64, exponent: f64) -> Result<f64, MemoryMathError> {
    if base == 0.0 && exponent < 0.0 && exponent.is_finite() {
        return Err(MemoryMathError::ZeroDivision);
    }
    let result = base.powf(exponent);
    if result.is_nan() && base.is_finite() && exponent.is_finite() {
        return Err(MemoryMathError::Domain);
    }
    if result.is_infinite() && base.is_finite() && exponent.is_finite() {
        return Err(MemoryMathError::Overflow);
    }
    Ok(result)
}
pub fn recency_score(
    created_at: f64,
    now: f64,
    decay_per_hour: f64,
) -> Result<f64, MemoryMathError> {
    let hours = (now - created_at) / 3600.0;
    python_pow(decay_per_hour, if hours > 0.0 { hours } else { 0.0 })
}
pub(super) fn clamp(value: f64, minimum: f64, maximum: f64) -> f64 {
    let value = if value < maximum { value } else { maximum };
    if value > minimum { value } else { minimum }
}
pub fn score_memory(
    relevance: f64,
    created_at: f64,
    importance: f64,
    now: f64,
    decay: f64,
    weights: [f64; 3],
    combine: &str,
) -> Result<f64, MemoryMathError> {
    let rel = clamp(relevance, 0.0, 1.0);
    let rec = recency_score(created_at, now, decay)?;
    let imp = clamp(importance / 10.0, 0.0, 1.0);
    let [a, b, c] = weights;
    if combine == "product" {
        return Ok(python_pow(rel, a)? * python_pow(rec, b)? * python_pow(imp, c)?);
    }
    let total = a + b + c;
    Ok((a * rel + b * rec + c * imp) / if total == 0.0 { 1.0 } else { total })
}
