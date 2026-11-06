#[path = "text_decimal.rs"]
mod decimal;
#[path = "text_lower.rs"]
mod lower_table;
#[path = "text_printable.rs"]
mod printable;
#[path = "text_properties.rs"]
mod tables;
fn contains(ranges: &[(u32, u32)], value: char) -> bool {
    let value = u32::from(value);
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
    let chars = text.chars().collect::<Vec<_>>();
    let mut output = String::new();
    for (index, &value) in chars.iter().enumerate() {
        if value == 'Σ' {
            let before = chars[..index]
                .iter()
                .rev()
                .find(|&&cp| !contains(tables::IGNORABLE, cp))
                .is_some_and(|&cp| contains(tables::CASED, cp));
            let after = chars[index + 1..]
                .iter()
                .find(|&&cp| !contains(tables::IGNORABLE, cp))
                .is_some_and(|&cp| contains(tables::CASED, cp));
            output.push(if before && !after { 'ς' } else { 'σ' });
        } else if let Ok(index) =
            lower_table::LOWER.binary_search_by_key(&u32::from(value), |&(key, _)| key)
        {
            output.extend(
                lower_table::LOWER[index]
                    .1
                    .iter()
                    .map(|&cp| char::from_u32(cp).expect("frozen scalar mapping")),
            );
        } else {
            output.push(value);
        }
    }
    output
}
pub fn normalize_utterance(text: &str) -> String {
    let mut text = trim_text(text);
    while let Some(value) = text.chars().next() {
        if contains(tables::ALNUM, value) {
            break;
        }
        text = text[value.len_utf8()..].trim_start_matches(whitespace);
    }
    collapse_whitespace(&lower(text))
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
