//! The Python text rules the adapter relies on.
use super::{Crash, RetainError};
use crate::legacy_json::{Node, Number, Value};
use crate::worker_config::python_float_repr;

/// `re.match(pattern + "$", text)`: `$` also matches before one final `\n`.
fn anchored(text: &[u32], body: impl Fn(&[u32]) -> bool) -> bool {
    body(text) || text.strip_suffix(&[u32::from('\n')]).is_some_and(body)
}

fn ascii(c: u32, test: impl Fn(u8) -> bool) -> bool {
    u8::try_from(c).is_ok_and(test)
}

/// `ID_RE = ^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`.
pub(super) fn is_id(text: &[u32]) -> bool {
    anchored(text, |text| {
        let Some((first, rest)) = text.split_first() else {
            return false;
        };
        ascii(*first, |c| c.is_ascii_alphanumeric())
            && rest.len() <= 63
            && rest
                .iter()
                .all(|c| ascii(*c, |c| c.is_ascii_alphanumeric() || b"._:-".contains(&c)))
    })
}

/// `SHA_RE = ^[0-9a-f]{64}$`.
pub(super) fn is_sha(text: &[u32]) -> bool {
    anchored(text, |text| {
        text.len() == 64
            && text
                .iter()
                .all(|c| ascii(*c, |c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)))
    })
}

/// `^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$`, with ASCII digits.
pub(super) fn is_utc(text: &[u32]) -> bool {
    anchored(text, |text| {
        let shape = b"dddd-dd-ddTdd:dd:ddZ";
        text.len() == shape.len()
            && text.iter().zip(shape).all(|(c, expected)| match expected {
                b'd' => ascii(*c, |c| c.is_ascii_digit()),
                literal => *c == u32::from(*literal),
            })
    })
}

/// `str.isspace()` for every character, so `not text.strip()`.
pub(super) fn python_blank(text: &str) -> bool {
    text.chars().all(|c| {
        matches!(
            c,
            '\t' | '\n'
                | '\u{b}'
                | '\u{c}'
                | '\r'
                | '\u{1c}'..='\u{1f}'
                | ' '
                | '\u{85}'
                | '\u{a0}'
                | '\u{1680}'
                | '\u{2000}'..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
        )
    })
}

/// The lines of a text-mode file with universal newlines: `\r\n` and `\r`
/// read as `\n`, each line keeping its newline.
pub fn universal_lines(text: &str) -> Vec<String> {
    let mut lines = Vec::new();
    let mut line = String::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\r' || c == '\n' {
            if c == '\r' && chars.peek() == Some(&'\n') {
                chars.next();
            }
            line.push('\n');
            lines.push(std::mem::take(&mut line));
        } else {
            line.push(c);
        }
    }
    if !line.is_empty() {
        lines.push(line);
    }
    lines
}

/// `repr(str)` escapes, as far as they can contain digits: ASCII and Latin-1
/// controls, the soft hyphen and lone surrogates. Other characters are kept.
fn repr_into(text: &[u32], out: &mut Vec<u32>) {
    for &c in text {
        let escaped = match c {
            0x09 | 0x0a | 0x0d | 0x5c => None,
            0..=0x1f | 0x7f..=0xa0 | 0xad => Some(format!("{c:02x}")),
            0xd800..=0xdfff => Some(format!("{c:04x}")),
            _ => {
                out.push(c);
                continue;
            }
        };
        out.extend(escaped.unwrap_or_default().chars().map(u32::from));
    }
}

/// Python `str(value)` for a JSON value, reduced to `[0-9TZ]`. Nested
/// strings use `repr`; object keys follow the decoded (sorted) order.
pub(super) fn digits_t_z(value: &Value) -> Vec<u32> {
    enum Part<'a> {
        Value(&'a Value, bool),
        Key(&'a [u32]),
    }
    let mut out = Vec::new();
    let mut pending = vec![Part::Value(value, true)];
    while let Some(part) = pending.pop() {
        let (value, top) = match part {
            Part::Key(key) => {
                repr_into(key, &mut out);
                continue;
            }
            Part::Value(value, top) => (value, top),
        };
        match &value.0 {
            Node::String(text) if top => out.extend(&text.0),
            Node::String(text) => repr_into(&text.0, &mut out),
            Node::Bool(true) => out.push(u32::from('T')),
            Node::Bool(false) | Node::Null => {}
            Node::Number(Number::Integer(digits)) => out.extend(digits.chars().map(u32::from)),
            Node::Number(Number::Float(number)) => {
                out.extend(python_float_repr(*number).chars().map(u32::from));
            }
            Node::Number(_) => {}
            Node::Array(values) => {
                pending.extend(values.iter().rev().map(|value| Part::Value(value, false)));
            }
            Node::Object(values) => {
                for (key, value) in values.iter().rev() {
                    pending.push(Part::Value(value, false));
                    pending.push(Part::Key(&key.0));
                }
            }
        }
    }
    out.retain(|c| ascii(*c, |c| c.is_ascii_digit() || c == b'T' || c == b'Z'));
    out
}

/// Days since 1970-01-01 to (year, month, day), proleptic Gregorian.
fn civil(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted + 2) / 5 + 1;
    let month = if shifted < 10 {
        shifted + 3
    } else {
        shifted - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// `time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(seconds))`. NaN is a
/// ValueError, a value outside time_t an OverflowError, and a year outside
/// C `int` an OSError from gmtime. `%Y` is unpadded, as glibc prints it.
pub(super) fn utc(seconds: f64) -> Result<String, RetainError> {
    if seconds.is_nan() {
        return Err(Crash("ValueError").into());
    }
    let floor = seconds.floor();
    if !(-9.223_372_036_854_776e18..9.223_372_036_854_776e18).contains(&floor) {
        return Err(Crash("OverflowError").into());
    }
    #[allow(clippy::cast_possible_truncation)]
    let whole = floor as i64;
    let (year, month, day) = civil(whole.div_euclid(86_400));
    if i32::try_from(year - 1900).is_err() {
        return Err(RetainError::Os);
    }
    let rest = whole.rem_euclid(86_400);
    Ok(format!(
        "{year}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60
    ))
}

/// Python `int(text)` for a command-line value: whitespace, a sign and
/// underscores between ASCII digits.
pub fn python_int(text: &str) -> Option<i128> {
    let text = text.trim();
    let (negative, digits) = match text.as_bytes().first() {
        Some(b'-') => (true, &text[1..]),
        Some(b'+') => (false, &text[1..]),
        _ => (false, text),
    };
    let plain = underscored(digits)?;
    let value = plain.parse::<i128>().ok()?;
    Some(if negative { -value } else { value })
}

/// Digits with optional single underscores between them, underscores removed.
fn underscored(text: &str) -> Option<String> {
    let mut plain = String::new();
    let mut previous_digit = false;
    for c in text.chars() {
        if c == '_' {
            if !previous_digit {
                return None;
            }
            previous_digit = false;
        } else {
            if !c.is_ascii_digit() {
                return None;
            }
            previous_digit = true;
            plain.push(c);
        }
    }
    (!text.is_empty() && !text.ends_with('_')).then_some(plain)
}

/// Python `float(text)`: whitespace, a sign, `inf`/`infinity`/`nan` in any
/// case, and underscores only between digits.
pub fn python_float(text: &str) -> Option<f64> {
    let text = text.trim();
    let body = text.strip_prefix(['+', '-']).unwrap_or(text);
    let lower = body.to_ascii_lowercase();
    if matches!(lower.as_str(), "inf" | "infinity" | "nan") {
        let value = if lower == "nan" {
            f64::NAN
        } else {
            f64::INFINITY
        };
        return Some(if text.starts_with('-') { -value } else { value });
    }
    if !body.starts_with(|c: char| c.is_ascii_digit() || c == '.') {
        return None;
    }
    let bytes = text.as_bytes();
    let between = bytes.iter().enumerate().all(|(at, byte)| {
        *byte != b'_'
            || (at > 0
                && bytes[at - 1].is_ascii_digit()
                && bytes.get(at + 1).is_some_and(u8::is_ascii_digit))
    });
    if !between {
        return None;
    }
    text.replace('_', "").parse().ok()
}
