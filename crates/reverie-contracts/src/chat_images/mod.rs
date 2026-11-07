//! Closed original M/image wire formats. Parsing supplies DATA, not access.
use crate::legacy_json::{self, Node, Number, Text, Value};
use reverie_core::chat_images::{ImageDigest, ImageScope, Raster};
use std::{collections::BTreeMap, fmt};
mod ledger;
mod message;
mod request;
mod response;
#[cfg(test)]
mod tests;
pub use ledger::{ImageLedger, LedgerEntry, decode_ledger, encode_ledger};
pub use message::message_file;
pub use request::{ImageRequest, decode_request, decode_scope};
pub use response::{ReadyImage, binding_response, ready_response};
pub const PURPOSE: &str = "chat-image-paths-v1";
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ImageDataError(&'static str);
impl ImageDataError {
    pub const fn new(code: &'static str) -> Self {
        Self(code)
    }
    pub fn code(self) -> &'static str {
        self.0
    }
}
impl fmt::Display for ImageDataError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(self.0)
    }
}
impl std::error::Error for ImageDataError {}
pub type Result<T> = std::result::Result<T, ImageDataError>;
fn key(name: &str) -> Text {
    Text(name.bytes().map(u32::from).collect())
}
fn object<'a>(value: &'a Value, code: &'static str) -> Result<&'a BTreeMap<Text, Value>> {
    match &value.0 {
        Node::Object(fields) => Ok(fields),
        _ => Err(ImageDataError(code)),
    }
}
fn field<'a>(fields: &'a BTreeMap<Text, Value>, name: &str) -> Option<&'a Value> {
    fields.get(&key(name))
}
fn text(value: Option<&Value>, code: &'static str) -> Result<String> {
    match value {
        Some(Value(Node::String(value))) => value
            .0
            .iter()
            .copied()
            .map(char::from_u32)
            .collect::<Option<String>>()
            .ok_or(ImageDataError(code)),
        _ => Err(ImageDataError(code)),
    }
}
fn need(value: bool, code: &'static str) -> Result<()> {
    if value {
        Ok(())
    } else {
        Err(ImageDataError(code))
    }
}
fn closed(fields: &BTreeMap<Text, Value>, names: &[&str]) -> bool {
    fields.len() == names.len() && names.iter().all(|name| fields.contains_key(&key(name)))
}
pub fn image_format(bytes: &[u8]) -> Result<Raster> {
    need(
        !bytes.is_empty() && bytes.len() <= reverie_core::chat_images::MAX_FILE_BYTES,
        "invalid_bytes",
    )?;
    Raster::detect(bytes).ok_or(ImageDataError("unsupported_image"))
}
pub fn image_digest(bytes: &[u8]) -> ImageDigest {
    use sha2::{Digest, Sha256};
    let digest: [u8; 32] = Sha256::digest(bytes).into();
    ImageDigest::parse(&crate::digest::hex(&digest)).expect("fixed SHA256 encoding")
}
