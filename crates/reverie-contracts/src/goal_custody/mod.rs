//! Closed Goal custody request and private configuration DATA. These codecs
//! establish no private filesystem, mount, peer, program or signing authority.
mod configuration;
#[cfg(test)]
mod tests;
use crate::legacy_json::{self, Node, Text, Value};
pub use configuration::{GoalPathPair, GoalPrivateConfig, GoalPrivatePath};
use std::{collections::BTreeMap, fmt};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GoalDataError {
    Json,
    Request,
    Configuration,
    Path,
    Scope,
    Mode,
}
impl fmt::Display for GoalDataError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str(match self {
            Self::Json => "GOAL_PRIVATE_JSON",
            Self::Request => "GOAL_CUSTODY_REQUEST",
            Self::Configuration => "GOAL_PRIVATE_CONFIGURATION",
            Self::Path => "GOAL_PRIVATE_PATH",
            Self::Scope => "GOAL_PRIVATE_SCOPE",
            Self::Mode => "GOAL_OWNER_ONLY_REQUIRED",
        })
    }
}
impl std::error::Error for GoalDataError {}
type Result<T> = std::result::Result<T, GoalDataError>;
type Object = BTreeMap<Text, Value>;

/// The only currently supported G request. Successful decoding is no caller
/// authorization, custody receipt or permission to disclose a private record.
pub struct GoalCustodyRequest(());
impl GoalCustodyRequest {
    pub fn decode(raw: &[u8]) -> Result<Self> {
        let value =
            legacy_json::decode_worker_request_bytes(raw).map_err(|_| GoalDataError::Json)?;
        let fields = object(&value.value).map_err(|_| GoalDataError::Request)?;
        let action = fields.get(&key("action"));
        if fields.len() != 1
            || !matches!(action, Some(Value(Node::String(action))) if action.equals_ascii("goal-custody"))
        {
            return Err(GoalDataError::Request);
        }
        Ok(Self(()))
    }
}
fn object(value: &Value) -> Result<&Object> {
    match &value.0 {
        Node::Object(fields) => Ok(fields),
        _ => Err(GoalDataError::Configuration),
    }
}
fn key(name: &str) -> Text {
    Text(name.bytes().map(u32::from).collect())
}
fn field<'a>(fields: &'a Object, name: &str) -> Result<&'a Value> {
    fields.get(&key(name)).ok_or(GoalDataError::Configuration)
}
fn text(value: &Value) -> Result<&Text> {
    match &value.0 {
        Node::String(value) => Ok(value),
        _ => Err(GoalDataError::Configuration),
    }
}
fn exact(fields: &Object, names: &[&str]) -> Result<()> {
    if fields.len() == names.len() && names.iter().all(|name| fields.contains_key(&key(name))) {
        Ok(())
    } else {
        Err(GoalDataError::Configuration)
    }
}
