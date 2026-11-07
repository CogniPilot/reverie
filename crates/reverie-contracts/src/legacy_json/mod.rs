//! Private lossless Python JSON primitives shared by named compatibility readers.
mod copy;
mod decode;
mod equality;
pub(crate) mod ordered;
#[cfg(test)]
mod tests;
mod text;
mod value;
pub(crate) use decode::{JournalParseError, JournalParsed};
pub(crate) use equality::numeric_key;
pub(crate) use value::{Node, Number, Text, Value, truthy};
/// Frozen standard Python 3.13 integer conversion bound. Only named readers
/// whose source performs that default conversion apply it.
pub(crate) const DEFAULT_INT_MAX_DIGITS: usize = 4300;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Error {
    InvalidJson,
    DuplicateKey,
}
pub(crate) fn decode_utf8(raw: &[u8]) -> Result<Value, Error> {
    decode::decode(raw)
}
#[cfg(test)]
pub(crate) fn decode_bytes(raw: &[u8]) -> Result<Value, Error> {
    decode::decode(&text::python_bytes(raw)?)
}
pub(crate) fn decode_bytes_without_constants(raw: &[u8]) -> Result<Value, Error> {
    decode::decode_without_constants(&text::python_bytes(raw)?)
}
/// OPS uses Python bytes JSON with close-time duplicate and literal constant
/// refusal and the original decimal conversion cap, including ignored slots.
pub(crate) fn decode_strict_bytes(raw: &[u8]) -> Result<Value, Error> {
    decode::decode_ops(&text::python_bytes(raw)?)
}
/// Metadata and fixed perf readers use Python bytes decoding, ordinary signed
/// integer conversion and close-time object_pairs_hook duplicate refusal.
/// Unlike strict constant readers, literal NaN and infinities remain data.
pub(crate) fn decode_metadata_bytes(raw: &[u8]) -> Result<Value, Error> {
    decode::decode_metadata(&text::python_bytes(raw)?)
}
/// Named callers supply Python `str` JSON as strict UTF-8. This deliberately
/// does not perform the bytes decoder's BOM/UTF16/32 detection.
pub(crate) fn decode_python_str(raw: &[u8]) -> Result<Value, Error> {
    std::str::from_utf8(raw).map_err(|_| Error::InvalidJson)?;
    decode::decode_last_wins(raw)
}
/// UTF-8 Path.read_text's universal newlines, shared by named file purposes.
/// JSON syntax/purpose policy remains with each caller; no bytes BOM detector.
pub(crate) fn utf8_file_text(raw: &[u8]) -> Result<String, Error> {
    Ok(std::str::from_utf8(raw)
        .map_err(|_| Error::InvalidJson)?
        .replace("\r\n", "\n")
        .replace('\r', "\n"))
}
/// Normal rootless seccomp JSON uses json.loads(bytes), without object_pairs_hook.
/// Keep this mode purpose-private; strict profile/perf/registry readers differ.
pub(crate) fn decode_rootless_profile(raw: &[u8]) -> Result<Value, Error> {
    decode::decode_last_wins(&text::python_bytes(raw)?)
}
pub(crate) fn decode_journal(raw: &[u8]) -> Result<JournalParsed, JournalParseError> {
    let raw = text::python_bytes(raw).map_err(JournalParseError::Json)?;
    decode::decode_journal(&raw)
}
