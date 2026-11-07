use super::{EmbeddingError, text};
/// Existing float(str) coercion used by the HTTP embedding response. Integer
/// JSON tokens have a separate overflow rule owned by the named response codec.
pub fn parse_embedding_float_text(points: &[u32]) -> Result<f64, EmbeddingError> {
    let source = text::numeric_ascii(points).ok_or(EmbeddingError::InvalidNumber)?;
    let source = source.trim_matches(|c| matches!(c, ' ' | '\t' | '\r' | '\n' | '\u{b}' | '\u{c}'));
    let (sign, body) = if let Some(body) = source.strip_prefix('-') {
        (-1.0, body)
    } else {
        (1.0, source.strip_prefix('+').unwrap_or(source))
    };
    match body.to_ascii_lowercase().as_str() {
        "nan" => return Ok(f64::NAN.copysign(sign)),
        "inf" | "infinity" => return Ok(f64::INFINITY.copysign(sign)),
        _ => {}
    }
    let raw = body.as_bytes();
    for (index, &byte) in raw.iter().enumerate() {
        if byte == b'_'
            && (index == 0
                || index + 1 == raw.len()
                || !raw[index - 1].is_ascii_digit()
                || !raw[index + 1].is_ascii_digit())
        {
            return Err(EmbeddingError::InvalidNumber);
        }
    }
    let compact = body.replace('_', "");
    if !valid_decimal(compact.as_bytes()) {
        return Err(EmbeddingError::InvalidNumber);
    }
    let number = compact
        .parse::<f64>()
        .map_err(|_| EmbeddingError::InvalidNumber)?;
    Ok(number.copysign(sign))
}
fn valid_decimal(raw: &[u8]) -> bool {
    let mut index = 0;
    while raw.get(index).is_some_and(u8::is_ascii_digit) {
        index += 1;
    }
    let mut digits = index;
    if raw.get(index) == Some(&b'.') {
        index += 1;
        let begin = index;
        while raw.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        digits += index - begin;
    }
    if digits == 0 {
        return false;
    }
    if raw.get(index).is_some_and(|b| matches!(b, b'e' | b'E')) {
        index += 1;
        if raw.get(index).is_some_and(|b| matches!(b, b'+' | b'-')) {
            index += 1;
        }
        let begin = index;
        while raw.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        if index == begin {
            return false;
        }
    }
    index == raw.len()
}
