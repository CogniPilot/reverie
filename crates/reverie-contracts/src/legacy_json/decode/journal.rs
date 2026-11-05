//! Private Python journal parse hooks. No wire/configuration selects a policy.
use super::*;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum JournalParseError {
    Json(Error),
    DocumentInteger,
    JsonNumber,
    Version,
}
pub(crate) struct JournalParsed {
    pub(crate) value: Value,
    pub(crate) root_object_orders: BTreeMap<Text, Vec<Text>>,
}
pub(super) fn decode(source: &[u8]) -> Result<JournalParsed, JournalParseError> {
    let mut cursor = Cursor::new(source, Purpose::Journal);
    match finish(&mut cursor) {
        Ok(value) => Ok(JournalParsed {
            value,
            root_object_orders: cursor.root_object_orders,
        }),
        Err(error) => Err(cursor
            .journal_error
            .unwrap_or(JournalParseError::Json(error))),
    }
}
impl Cursor<'_> {
    pub(super) fn journal_failure<T>(&mut self, error: JournalParseError) -> Result<T, Error> {
        self.journal_error = Some(error);
        Err(Error::InvalidJson)
    }
}
pub(super) fn number(cursor: &mut Cursor<'_>) -> Result<Number, Error> {
    let begin = cursor.offset;
    if cursor.source[begin..].starts_with(b"-Infinity") {
        return cursor.journal_failure(JournalParseError::JsonNumber);
    }
    let end = number_end(cursor.source, begin).ok_or(Error::InvalidJson)?;
    let text = &cursor.source[begin..end];
    cursor.offset = end;
    if text.iter().any(|byte| b".eE".contains(byte)) {
        return cursor.journal_failure(JournalParseError::JsonNumber);
    }
    if text.len() > 16 || !text.iter().all(u8::is_ascii_digit) {
        return cursor.journal_failure(JournalParseError::DocumentInteger);
    }
    let text = std::str::from_utf8(text).map_err(|_| Error::InvalidJson)?;
    let value = text.parse::<u64>().map_err(|_| Error::InvalidJson)?;
    if value > reverie_core::revision::JS_SAFE_MAX {
        return cursor.journal_failure(JournalParseError::Version);
    }
    Ok(Number::Integer(text.into()))
}
// Match the JSON numeric PREFIX before invoking its callback, as Python's
// decoder does. A malformed suffix must not hide an earlier integer-hook fault.
fn number_end(raw: &[u8], begin: usize) -> Option<usize> {
    let mut end = begin + usize::from(raw.get(begin) == Some(&b'-'));
    match raw.get(end)? {
        b'0' => end += 1,
        b'1'..=b'9' => {
            end += 1;
            digits(raw, &mut end);
        }
        _ => return None,
    }
    if raw.get(end) == Some(&b'.') && raw.get(end + 1).is_some_and(u8::is_ascii_digit) {
        end += 2;
        digits(raw, &mut end);
    }
    if raw.get(end).is_some_and(|b| matches!(b, b'e' | b'E')) {
        let mut exponent = end + 1;
        if raw.get(exponent).is_some_and(|b| matches!(b, b'+' | b'-')) {
            exponent += 1;
        }
        if raw.get(exponent).is_some_and(u8::is_ascii_digit) {
            digits(raw, &mut exponent);
            end = exponent;
        }
    }
    Some(end)
}
fn digits(raw: &[u8], end: &mut usize) {
    while raw.get(*end).is_some_and(u8::is_ascii_digit) {
        *end += 1;
    }
}
