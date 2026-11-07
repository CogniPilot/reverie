use super::*;
use reverie_core::{python_numeric_text, python_trim_text as trim_text};
fn scalar_number(raw: &str) -> Option<String> {
    let value = python_numeric_text(&raw.replace('_', ""))?;
    (!value.bytes().any(|byte| matches!(byte, 0x1c..=0x1f))).then_some(value)
}
pub(super) fn integer(raw: &str) -> bool {
    // SafeConstructor dispatches on the ORIGINAL spelling after underscore
    // removal. Unicode decimal conversion belongs to the selected int(base)
    // call, not the ASCII prefix/octal/sexagesimal branch decision.
    let value = raw.replace('_', "");
    let signless = value.strip_prefix(['+', '-']).unwrap_or(&value);
    if signless == "0" {
        return true;
    }
    if let Some(value) = signless.strip_prefix("0b") {
        return radix(value, 2);
    }
    if let Some(value) = signless.strip_prefix("0x") {
        return radix(value, 16);
    }
    if signless.starts_with('0') {
        return radix(signless, 8);
    }
    if signless.contains(':') {
        return signless.split(':').all(decimal);
    }
    // SafeConstructor has already consumed its first sign before int(value).
    // The conversion can consume a second sign or intervening whitespace.
    decimal(signless)
}
fn decimal(value: &str) -> bool {
    let Some(value) = scalar_number(value) else {
        return false;
    };
    let value = trim_text(&value)
        .strip_prefix(['+', '-'])
        .unwrap_or(trim_text(&value));
    !value.is_empty()
        && value.len() <= legacy_json::DEFAULT_INT_MAX_DIGITS
        && value.bytes().all(|byte| byte.is_ascii_digit())
}
fn radix(value: &str, base: u32) -> bool {
    let Some(value) = scalar_number(value) else {
        return false;
    };
    let value = trim_text(&value)
        .strip_prefix(['+', '-'])
        .unwrap_or(trim_text(&value));
    let prefixes = match base {
        2 => ["0b", "0B"],
        8 => ["0o", "0O"],
        16 => ["0x", "0X"],
        _ => unreachable!("fixed Python conversion base"),
    };
    let value = value
        .strip_prefix(prefixes[0])
        .or_else(|| value.strip_prefix(prefixes[1]))
        .unwrap_or(value);
    !value.is_empty() && value.chars().all(|point| point.is_digit(base))
}
pub(super) fn float(raw: &str) -> bool {
    let Some(value) = scalar_number(raw) else {
        return false;
    };
    let value = value.to_ascii_lowercase();
    let value = value.strip_prefix(['+', '-']).unwrap_or(&value);
    if matches!(value, ".inf" | ".nan") {
        return true;
    }
    value
        .split(':')
        .all(|part| trim_text(part).parse::<f64>().is_ok())
}
pub(super) fn binary(value: &str) -> Result<usize> {
    if !value.is_ascii() {
        return Err(GpuDataError::CdiDocument);
    }
    let mut digits = 0usize;
    let mut trailing_padding = 0usize;
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/') {
            digits += 1;
            trailing_padding = 0;
        } else if byte == b'=' {
            trailing_padding += 1;
        }
    }
    let remaining = digits % 4;
    if remaining != 1 && (remaining == 0 || trailing_padding >= 4 - remaining) {
        Ok(digits * 6 / 8)
    } else {
        Err(GpuDataError::CdiDocument)
    }
}
