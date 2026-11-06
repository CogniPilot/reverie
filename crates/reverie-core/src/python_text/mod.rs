//! Shared frozen Python text facts for scalar and lossless codepoint consumers.
//! No host/HTTP dependencies, normalization, identity or authority is supplied.
mod borrowed;
mod decimal;
mod lower_table;
mod points;
mod printable;
mod tables;
pub use borrowed::PythonTextRef;
pub use points::{PythonText, PythonTextError};
#[cfg(test)]
mod tests;
#[cfg(test)]
mod value_tests;
fn contains(ranges: &[(u32, u32)], value: char) -> bool {
    contains_point(ranges, u32::from(value))
}
fn contains_point(ranges: &[(u32, u32)], value: u32) -> bool {
    let index = ranges.partition_point(|&(start, _)| start <= value);
    index > 0 && value <= ranges[index - 1].1
}
fn whitespace(value: char) -> bool {
    contains(tables::WHITESPACE, value)
}
pub fn trim_text(text: &str) -> &str {
    text.trim_matches(whitespace)
}
pub fn collapse_whitespace(text: &str) -> String {
    text.split(whitespace)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}
pub(super) fn lower(text: &str) -> String {
    lower_codepoints(&text.chars().map(u32::from).collect::<Vec<_>>())
        .into_iter()
        .map(|cp| char::from_u32(cp).expect("scalar lower mapping"))
        .collect()
}
/// Frozen Python str.lower over lossless metadata codepoints. Lone surrogates
/// remain unchanged, including their noncased/nonignorable context behavior.
pub(crate) fn lower_codepoints(chars: &[u32]) -> Vec<u32> {
    let mut output = Vec::new();
    for (index, &value) in chars.iter().enumerate() {
        if value == u32::from('Σ') {
            let before = chars[..index]
                .iter()
                .rev()
                .find(|&&cp| !contains_point(tables::IGNORABLE, cp))
                .is_some_and(|&cp| contains_point(tables::CASED, cp));
            let after = chars[index + 1..]
                .iter()
                .find(|&&cp| !contains_point(tables::IGNORABLE, cp))
                .is_some_and(|&cp| contains_point(tables::CASED, cp));
            output.push(u32::from(if before && !after { 'ς' } else { 'σ' }));
        } else if let Ok(index) = lower_table::LOWER.binary_search_by_key(&value, |&(key, _)| key) {
            output.extend_from_slice(lower_table::LOWER[index].1);
        } else {
            output.push(value);
        }
    }
    output
}
/// Frozen Python 3.13 lowercase of one character. IDNA nameprep applies this
/// per character, independently of whole-string sigma context.
pub fn python_lowercase_character(value: char) -> String {
    lower_codepoints(&[u32::from(value)])
        .into_iter()
        .map(|cp| char::from_u32(cp).expect("scalar lowercase mapping"))
        .collect()
}
pub fn python_lowercase_string(value: &str) -> String {
    lower(value)
}
pub fn python_numeric_text(value: &str) -> Option<String> {
    numeric_ascii(&value.chars().map(u32::from).collect::<Vec<_>>())
}
pub fn normalize_utterance(text: &str) -> String {
    normalize_utterance_text(PythonTextRef::from_scalar_text(text))
        .codepoints()
        .iter()
        .map(|&cp| char::from_u32(cp).expect("scalar voice normalization"))
        .collect()
}
pub fn normalize_utterance_text(text: PythonTextRef<'_>) -> PythonText {
    let points = text.codepoints();
    let first = points
        .iter()
        .position(|&cp| contains_point(tables::ALNUM, cp))
        .unwrap_or(points.len());
    let lowered = lower_codepoints(&points[first..]);
    let mut output = Vec::new();
    let mut separator = false;
    for point in lowered {
        if contains_point(tables::WHITESPACE, point) {
            separator = !output.is_empty();
        } else {
            if separator {
                output.push(32);
                separator = false;
            }
            output.push(point);
        }
    }
    PythonText::try_new(output).expect("checked input and frozen lower facts")
}
/// Python's string repr for JSON-representable metadata recall. Lone
/// surrogates are escaped; the returned Rust string is always scalar text.
pub fn quoted_memory_text(points: &[u32]) -> Option<String> {
    if points.iter().any(|&point| point > 0x10ffff) {
        return None;
    }
    let quote = if points.contains(&39) && !points.contains(&34) {
        '"'
    } else {
        '\''
    };
    let mut result = String::from(quote);
    for &point in points {
        match point {
            92 => result.push_str("\\\\"),
            9 => result.push_str("\\t"),
            10 => result.push_str("\\n"),
            13 => result.push_str("\\r"),
            cp if cp == u32::from(quote) => {
                result.push('\\');
                result.push(quote);
            }
            cp => {
                if let Some(value) = char::from_u32(cp)
                    && contains(printable::PRINTABLE, value)
                {
                    result.push(value);
                } else if cp <= 255 {
                    result.push_str(&format!("\\x{cp:02x}"));
                } else if cp <= 65535 {
                    result.push_str(&format!("\\u{cp:04x}"));
                } else {
                    result.push_str(&format!("\\U{cp:08x}"));
                }
            }
        }
    }
    result.push(quote);
    Some(result)
}
pub(super) fn numeric_ascii(points: &[u32]) -> Option<String> {
    let mut output = String::new();
    for &point in points {
        if point < 128 {
            output.push(char::from_u32(point)?);
            continue;
        }
        let value = char::from_u32(point)?;
        if whitespace(value) {
            output.push(' ');
            continue;
        }
        let index = decimal::DECIMAL.partition_point(|&(start, _, _)| start <= point);
        if index == 0 || point > decimal::DECIMAL[index - 1].1 {
            return None;
        }
        let (start, _, zero) = decimal::DECIMAL[index - 1];
        output.push(char::from_u32(48 + (point - start + zero) % 10)?);
    }
    Some(output)
}
