//! V8 `JSON.stringify` with no replacer or indent. Recursion follows the value's depth, which every
//! parsed value has already had bounded by `parse`.
use super::{Object, Value};
use std::fmt::Write;

pub fn stringify(value: &Value, output: &mut String) {
    match value {
        Value::Null => output.push_str("null"),
        Value::Bool(true) => output.push_str("true"),
        Value::Bool(false) => output.push_str("false"),
        Value::Number(number_value) => number(*number_value, output),
        Value::String(units) => quote(output, units),
        Value::Array(items) => {
            output.push('[');
            for (position, item) in items.iter().enumerate() {
                if position > 0 {
                    output.push(',');
                }
                stringify(item, output);
            }
            output.push(']');
        }
        Value::Object(object) => stringify_object(object, output),
    }
}

/// Own keys in ECMAScript order: array indices ascending, then every other key in creation order.
fn stringify_object(object: &Object, output: &mut String) {
    let mut indexed: Vec<(u32, &Vec<u16>, &Value)> = Vec::new();
    let mut named: Vec<(&Vec<u16>, &Value)> = Vec::new();
    for (key, value) in object.entries() {
        match array_index(key) {
            Some(index) => indexed.push((index, key, value)),
            None => named.push((key, value)),
        }
    }
    indexed.sort_unstable_by_key(|(index, _, _)| *index);
    output.push('{');
    let ordered = indexed
        .into_iter()
        .map(|(_, key, value)| (key, value))
        .chain(named);
    for (position, (key, value)) in ordered.enumerate() {
        if position > 0 {
            output.push(',');
        }
        quote(output, key);
        output.push(':');
        stringify(value, output);
    }
    output.push('}');
}

/// The canonical decimal spelling of an integer in `0 ..= 2^32 - 2`, the array-index keys.
fn array_index(key: &[u16]) -> Option<u32> {
    if key.is_empty() || key.len() > 10 || (key.len() > 1 && key[0] == u16::from(b'0')) {
        return None;
    }
    let mut value: u64 = 0;
    for &unit in key {
        let digit = u8::try_from(unit).ok().filter(u8::is_ascii_digit)?;
        value = value * 10 + u64::from(digit - b'0');
    }
    u32::try_from(value).ok().filter(|index| *index != u32::MAX)
}

/// ECMAScript `Number::toString(10)`. JSON writes a non-finite number as `null` and `-0` as `0`.
pub fn number(value: f64, output: &mut String) {
    if !value.is_finite() {
        output.push_str("null");
        return;
    }
    if value == 0.0 {
        output.push('0');
        return;
    }
    if value < 0.0 {
        output.push('-');
    }
    let (digits, n) = shortest_digits(value.abs());
    let k = digits.len() as i64;
    if k <= n && n <= 21 {
        output.push_str(&digits);
        output.extend(std::iter::repeat_n('0', (n - k) as usize));
    } else if 0 < n && n <= 21 {
        output.push_str(&digits[..n as usize]);
        output.push('.');
        output.push_str(&digits[n as usize..]);
    } else if -6 < n && n <= 0 {
        output.push_str("0.");
        output.extend(std::iter::repeat_n('0', (-n) as usize));
        output.push_str(&digits);
    } else {
        output.push_str(&digits[..1]);
        if k > 1 {
            output.push('.');
            output.push_str(&digits[1..]);
        }
        output.push('e');
        output.push(if n > 0 { '+' } else { '-' });
        let _ = write!(output, "{}", (n - 1).abs());
    }
}

/// The digits `s` and exponent `n` of Number::toString for a positive finite `value`: the fewest
/// digits that round-trip, then the candidate closest to `value`, then (on an exact tie) the even one.
fn shortest_digits(value: f64) -> (String, i64) {
    // Rust's `{:e}` gives the fewest round-tripping digits, as `d.ddde<exp>`, but on an exact tie
    // between two such candidates it does not prefer the even one.
    let (digits, n) = scientific_digits(&format!("{value:e}"));
    let k = digits.len();
    for other in [decrement(&digits), increment(&digits)]
        .into_iter()
        .flatten()
    {
        if other.len() != k || other.as_bytes()[k - 1] % 2 != 0 {
            continue;
        }
        let low = if other < digits { &other } else { &digits };
        let midpoint = format!("0.{low}5e{n}");
        // A tie means `value` is exactly the midpoint. Parsing rounds correctly, so this filters
        // cheaply; the exact expansion then confirms it.
        if midpoint.parse::<f64>() != Ok(value) || !is_exact(value, &format!("{low}5"), n) {
            continue;
        }
        if format!("0.{other}e{n}").parse::<f64>() == Ok(value) {
            return (other, n);
        }
    }
    (digits, n)
}

/// The significant digits (without trailing zeros) and `n` of a `{:e}` spelling `d.ddde<exp>`.
fn scientific_digits(scientific: &str) -> (String, i64) {
    let (mantissa, exponent) = scientific
        .split_once('e')
        .expect("`{:e}` always writes an exponent");
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let digits = digits.trim_end_matches('0');
    let digits = if digits.is_empty() { "0" } else { digits };
    let n = exponent
        .parse::<i64>()
        .expect("`{:e}` writes a decimal exponent")
        + 1;
    (digits.to_string(), n)
}

/// Whether `value` is exactly `0.<digits> × 10^n`. A double's exact decimal expansion has at most
/// 767 significant digits, so 800 fractional digits of `{:e}` (which rounds exactly) are all of it.
fn is_exact(value: f64, digits: &str, n: i64) -> bool {
    scientific_digits(&format!("{value:.800e}")) == (digits.to_string(), n)
}

fn decrement(digits: &str) -> Option<String> {
    let mut bytes = digits.as_bytes().to_vec();
    for byte in bytes.iter_mut().rev() {
        if *byte > b'0' {
            *byte -= 1;
            return String::from_utf8(bytes)
                .ok()
                .filter(|text| !text.starts_with('0'));
        }
        *byte = b'9';
    }
    None
}

fn increment(digits: &str) -> Option<String> {
    let mut bytes = digits.as_bytes().to_vec();
    for byte in bytes.iter_mut().rev() {
        if *byte < b'9' {
            *byte += 1;
            return String::from_utf8(bytes).ok();
        }
        *byte = b'0';
    }
    None
}

/// ECMAScript QuoteJSONString: short escapes, other C0 and lone surrogates as lowercase `\uXXXX`.
pub fn quote(output: &mut String, units: &[u16]) {
    output.push('"');
    for decoded in char::decode_utf16(units.iter().copied()) {
        match decoded {
            Ok('"') => output.push_str("\\\""),
            Ok('\\') => output.push_str("\\\\"),
            Ok('\u{8}') => output.push_str("\\b"),
            Ok('\u{c}') => output.push_str("\\f"),
            Ok('\n') => output.push_str("\\n"),
            Ok('\r') => output.push_str("\\r"),
            Ok('\t') => output.push_str("\\t"),
            Ok(control) if control < ' ' => push_escape(output, control as u16),
            Ok(character) => output.push(character),
            Err(lone) => push_escape(output, lone.unpaired_surrogate()),
        }
    }
    output.push('"');
}

fn push_escape(output: &mut String, unit: u16) {
    // Writing to a String cannot fail.
    let _ = write!(output, "\\u{unit:04x}");
}
