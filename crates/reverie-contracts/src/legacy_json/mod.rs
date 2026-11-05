//! Private lossless Python JSON primitives shared by named compatibility readers.
mod decode;
mod equality;
#[cfg(test)]
mod tests;
mod text;
mod value;
pub(crate) use equality::numeric_key;
pub(crate) use value::{Node, Number, Text, Value};
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Error {
    InvalidJson,
    DuplicateKey,
}
pub(crate) fn decode_utf8(raw: &[u8]) -> Result<Value, Error> {
    decode::decode(raw)
}
pub(crate) fn decode_bytes(raw: &[u8]) -> Result<Value, Error> {
    decode::decode(&text::python_bytes(raw)?)
}
