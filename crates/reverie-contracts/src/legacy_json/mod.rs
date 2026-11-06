//! Private lossless Python JSON primitives shared by named compatibility readers.
mod decode;
mod equality;
#[cfg(test)]
mod tests;
mod text;
mod value;
pub(crate) use equality::numeric_key;
pub(crate) use value::{Node, Number, Text, Value};
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
/// worker_storage.read_metadata uses Python bytes decoding, ordinary signed
/// integer conversion and close-time object_pairs_hook duplicate refusal.
/// Unlike strict constant readers, literal NaN and infinities remain data.
pub(crate) fn decode_metadata_bytes(raw: &[u8]) -> Result<Value, Error> {
    decode::decode_metadata(&text::python_bytes(raw)?)
}
