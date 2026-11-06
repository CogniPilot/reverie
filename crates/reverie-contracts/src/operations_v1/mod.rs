//! Existing closed operations journal. Data and hashes never grant host authority.
mod decode;
mod encode;
use crate::legacy_json::{Node, Number, Text, Value};
pub use decode::{decode, decode_observation, decode_request, decode_scope};
pub(crate) use encode::operation;
pub use encode::{encode, observation_digest, operation_digest, request_digest, scope_digest};
use reverie_core::operations::{OperationError, Result};
use std::collections::BTreeMap;
pub const SCHEMA: &str = "reverie-laptop-resource-operations-v1";
pub const MAX_BYTES: usize = 524_288;
type Object = BTreeMap<Text, Value>;
fn error(code: &'static str) -> OperationError {
    OperationError::new(code)
}
fn need(value: bool, code: &'static str) -> Result<()> {
    if value { Ok(()) } else { Err(error(code)) }
}
fn key(value: &str) -> Text {
    Text(value.bytes().map(u32::from).collect())
}
fn object(value: &Value) -> Result<&Object> {
    if let Node::Object(value) = &value.0 {
        Ok(value)
    } else {
        Err(error("CLOSED_SCHEMA"))
    }
}
fn exact<'a>(value: &'a Value, keys: &[&str]) -> Result<&'a Object> {
    let fields = object(value)?;
    need(
        fields.len() == keys.len() && keys.iter().all(|name| fields.contains_key(&key(name))),
        "CLOSED_SCHEMA",
    )?;
    Ok(fields)
}
fn field<'a>(fields: &'a Object, name: &str) -> Result<&'a Value> {
    fields.get(&key(name)).ok_or(error("CLOSED_SCHEMA"))
}
fn text(value: &Value, code: &'static str) -> Result<String> {
    if let Node::String(value) = &value.0 {
        value
            .0
            .iter()
            .map(|&cp| char::from_u32(cp))
            .collect::<Option<_>>()
            .ok_or(error(code))
    } else {
        Err(error(code))
    }
}
fn uint(value: &Value, positive: bool) -> Result<u64> {
    let value = text(value, "UINT64")?;
    need(
        !value.is_empty()
            && value.len() <= 20
            && value.bytes().all(|b| b.is_ascii_digit())
            && (value == "0" || !value.starts_with('0')),
        "UINT64",
    )?;
    let value = value.parse().map_err(|_| error("UINT64"))?;
    need(!positive || value > 0, "POSITIVE_MEMORY")?;
    Ok(value)
}
fn version(value: &Value, positive: bool) -> Result<u64> {
    let Node::Number(Number::Integer(value)) = &value.0 else {
        return Err(error("VERSION"));
    };
    let value: u64 = value.parse().map_err(|_| error("VERSION"))?;
    need(
        value <= reverie_core::revision::JS_SAFE_MAX && (!positive || value > 0),
        "VERSION",
    )?;
    Ok(value)
}
