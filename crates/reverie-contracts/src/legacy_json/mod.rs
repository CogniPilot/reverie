//! Private lossless Python JSON primitives shared by named compatibility readers.
mod copy;
mod decode;
mod equality;
pub(crate) mod ordered;
#[cfg(test)]
mod tests;
mod text;
mod value;
pub(crate) use decode::GpuControlParseError;
pub(crate) use decode::{JournalParseError, JournalParsed};
pub(crate) use equality::numeric_key;
pub(crate) use value::{Node, Number, Text, Value, truthy};
/// Frozen default Python3.13 decimal conversion bound, used only by named
/// compatibility readers whose source performs this conversion.
pub(crate) const DEFAULT_INT_MAX_DIGITS: usize = 4300;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Error {
    InvalidJson,
    DuplicateKey,
}
pub(crate) fn decode_utf8(raw: &[u8]) -> Result<Value, Error> {
    decode::decode(raw)
}
pub(crate) fn decode_ordered_utf8(raw: &[u8]) -> Result<ordered::OrderedValue, Error> {
    decode::decode_ordered(raw, decode::Purpose::Default)
}
/// worker_storage.read_metadata uses Python bytes decoding, ordinary signed
/// integer conversion and close-time object_pairs_hook duplicate refusal.
/// Unlike strict constant readers, literal NaN and infinities remain data.
pub(crate) fn decode_metadata_bytes(raw: &[u8]) -> Result<Value, Error> {
    decode::decode_metadata(&text::python_bytes(raw)?)
}
pub(crate) fn decode_ordered_metadata_bytes(raw: &[u8]) -> Result<ordered::OrderedValue, Error> {
    decode::decode_ordered(&text::python_bytes(raw)?, decode::Purpose::Metadata)
}
/// `json.loads(str)` of already decoded text: duplicate keys last-wins and
/// literal constants accepted. There is no byte-encoding detection, so a BOM is
/// invalid JSON, as in Python.
pub(crate) fn decode_text(text: &str) -> Result<Value, Error> {
    decode::decode_last_wins(text.as_bytes())
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
/// Engine stdout has already undergone strict UTF-8 decoding; unlike bytes JSON
/// there is no BOM/UTF16/32 auto-detection at this purpose boundary.
pub(crate) fn decode_engine_inventory(raw: &[u8]) -> Result<Value, Error> {
    decode_python_str(raw)
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
pub(crate) fn decode_python_str_ordered(raw: &[u8]) -> Result<ordered::OrderedValue, Error> {
    std::str::from_utf8(raw).map_err(|_| Error::InvalidJson)?;
    decode::decode_ordered(raw, decode::Purpose::Rootless)
}
/// Shared strict Python bytes hooks: close-time duplicates, default integer
/// cap and literal constant refusal; exponent overflow remains data.
pub(crate) fn decode_strict_bytes(raw: &[u8]) -> Result<Value, Error> {
    decode::decode_engine_stopped(&text::python_bytes(raw)?)
}
/// Fixed helper replies use strict UTF-8, without bytes-JSON encoding detection.
pub(crate) fn decode_soft_limit_reply(raw: &[u8]) -> Result<Value, Error> {
    std::str::from_utf8(raw).map_err(|_| Error::InvalidJson)?;
    decode::decode_engine_stopped(raw)
}
pub(crate) fn decode_gpu_control_bytes(raw: &[u8]) -> Result<Value, GpuControlParseError> {
    let raw = text::python_bytes(raw).map_err(GpuControlParseError::Json)?;
    decode::decode_gpu_control(&raw)
}
pub(crate) fn decode_ops_private_bytes(raw: &[u8]) -> Result<ordered::OrderedValue, Error> {
    decode::decode_ordered(&text::python_bytes(raw)?, decode::Purpose::StrictEngine)
}
pub(crate) fn decode_memory_str(raw: &[u8]) -> Result<ordered::OrderedValue, Error> {
    std::str::from_utf8(raw).map_err(|_| Error::InvalidJson)?;
    decode::decode_ordered(raw, decode::Purpose::Rootless)
}
/// The memory CLI consumes TextIOWrapper's already-decoded Python str. Keep
/// literal surrogate codepoints distinct: this is not bytes JSON/BOM detection
/// or a serialize/reparse clone. The normal JSON lexer still owns all syntax.
pub(crate) fn decode_memory_cli_text(
    raw: reverie_core::PythonTextRef<'_>,
) -> Result<ordered::OrderedValue, Error> {
    decode::decode_ordered(&text::python_text(raw), decode::Purpose::Rootless)
}
pub(crate) fn decode_embedding_bytes(raw: &[u8]) -> Result<ordered::OrderedValue, Error> {
    decode::decode_ordered(&text::python_bytes(raw)?, decode::Purpose::Rootless)
}
/// The broker's J/L request frame uses default json.loads(bytes), retaining
/// first-key insertion order and last values. The transport bound is separate.
pub(crate) fn decode_worker_request_bytes(raw: &[u8]) -> Result<ordered::OrderedValue, Error> {
    decode::decode_ordered(&text::python_bytes(raw)?, decode::Purpose::Rootless)
}
/// Terminal R frames use ordinary json.loads(bytes), with default constants,
/// integer conversion and encoding detection. Dimension rules are separate.
pub(crate) fn decode_worker_terminal_bytes(raw: &[u8]) -> Result<Value, Error> {
    decode::decode_last_wins(&text::python_bytes(raw)?)
}
pub(crate) fn decode_private_child_text(raw: &[u8]) -> Result<ordered::OrderedValue, Error> {
    std::str::from_utf8(raw).map_err(|_| Error::InvalidJson)?;
    decode::decode_ordered(raw, decode::Purpose::Rootless)
}
pub(crate) fn decode_engine_stopped(raw: &[u8]) -> Result<Value, Error> {
    std::str::from_utf8(raw).map_err(|_| Error::InvalidJson)?;
    decode::decode_engine_stopped(raw)
}
pub(crate) fn decode_bytes_without_constants(raw: &[u8]) -> Result<Value, Error> {
    decode::decode_without_constants(&text::python_bytes(raw)?)
}
