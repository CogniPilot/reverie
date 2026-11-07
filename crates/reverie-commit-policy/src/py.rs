//! The few Python semantics the policy rules depend on: `str.splitlines`, `str.strip`, `re`
//! case-insensitive literal matching, and truthiness and equality of JSON values.

use serde_json::Value;

/// Python `str.splitlines()` boundaries: `\n`, `\r`, `\r\n`, VT, FF, the file/group/record
/// separators, NEL and the Unicode line and paragraph separators. No trailing empty line.
pub(crate) fn splitlines(text: &str) -> Vec<&str> {
    let mut lines = Vec::new();
    let mut start = 0;
    let mut chars = text.char_indices().peekable();
    while let Some((at, ch)) = chars.next() {
        let boundary = matches!(
            ch,
            '\n' | '\r'
                | '\u{b}'
                | '\u{c}'
                | '\u{1c}'
                | '\u{1d}'
                | '\u{1e}'
                | '\u{85}'
                | '\u{2028}'
                | '\u{2029}'
        );
        if !boundary {
            continue;
        }
        lines.push(&text[start..at]);
        start = at + ch.len_utf8();
        if ch == '\r' && chars.peek().is_some_and(|&(_, next)| next == '\n') {
            chars.next();
            start += 1;
        }
    }
    if start < text.len() {
        lines.push(&text[start..]);
    }
    lines
}

/// Python `str.isspace()` for one character (and `\s` in `str` patterns).
pub(crate) fn is_space(ch: char) -> bool {
    ch.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&ch)
}

/// Python `str.strip()` with no arguments.
pub(crate) fn strip(text: &str) -> &str {
    text.trim_matches(is_space)
}

/// `re.IGNORECASE` equality of an ASCII pattern character against text: ASCII case folding plus
/// the non-ASCII characters Python also folds onto `i`, `s` and `k`.
pub(crate) fn ignorecase_eq(pattern: char, text: char) -> bool {
    if pattern == text {
        return true;
    }
    if !pattern.is_ascii_alphabetic() {
        return false;
    }
    let lower = pattern.to_ascii_lowercase();
    (text.is_ascii() && text.to_ascii_lowercase() == lower)
        || matches!(
            (lower, text),
            ('i', '\u{130}' | '\u{131}') | ('s', '\u{17f}') | ('k', '\u{212a}')
        )
}

/// Python truthiness of a decoded JSON value.
pub(crate) fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(items)) => !items.is_empty(),
        Some(Value::Object(map)) => !map.is_empty(),
    }
}

/// Python `==` between decoded JSON values, where `true == 1` and `1 == 1.0`.
pub(crate) fn eq(left: &Value, right: &Value) -> bool {
    match (numeric(left), numeric(right)) {
        (Some(a), Some(b)) => a == b,
        (Some(_), None) | (None, Some(_)) => false,
        (None, None) => match (left, right) {
            (Value::Array(a), Value::Array(b)) => {
                a.len() == b.len() && a.iter().zip(b).all(|(x, y)| eq(x, y))
            }
            (Value::Object(a), Value::Object(b)) => {
                a.len() == b.len()
                    && a.iter()
                        .all(|(key, x)| b.get(key).is_some_and(|y| eq(x, y)))
            }
            _ => left == right,
        },
    }
}

fn numeric(value: &Value) -> Option<f64> {
    match value {
        Value::Bool(flag) => Some(f64::from(u8::from(*flag))),
        Value::Number(number) => number.as_f64(),
        _ => None,
    }
}

/// Whether a value could be a member of a Python `set` (lists and objects are unhashable).
pub(crate) fn hashable(value: &Value) -> bool {
    !matches!(value, Value::Array(_) | Value::Object(_))
}
