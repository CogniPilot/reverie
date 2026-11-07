//! Private lossless Python JSON primitives shared by named compatibility readers.
mod copy;
mod decode;
mod equality;
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
/// `json.loads(str)` of already decoded text: duplicate keys last-wins and
/// literal constants accepted. A BOM is invalid JSON, as in Python.
pub(crate) fn decode_text(text: &str) -> Result<Value, Error> {
    decode::decode_last_wins(text.as_bytes())
}
/// `json.loads(bytes)` with its defaults: byte-encoding detection, duplicate
/// keys last-wins, literal constants and the decimal conversion cap.
pub(crate) fn decode_loads_bytes(raw: &[u8]) -> Result<Value, Error> {
    decode::decode_last_wins(&text::python_bytes(raw)?)
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
