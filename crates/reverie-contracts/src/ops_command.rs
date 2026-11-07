//! The existing fixed Office OPS command/reply wire. These are DATA, never
//! owner authority, a native permit or proof that an effect completed.
use crate::legacy_json::{self, Node, Number, Text, Value, truthy};
use reverie_core::ops::OpsServiceId;
use std::{collections::BTreeMap, fmt};
mod validation;
type Object = BTreeMap<Text, Value>;
pub const MAX_SUBMIT_BYTES: usize = 16_384;
pub const MAX_REPLY_BYTES: usize = 65_536;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OpsDataError {
    Json,
    Shape,
    Identifier,
    Digest,
    Bound,
}
impl fmt::Display for OpsDataError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        out.write_str("invalid OPS wire data")
    }
}
impl std::error::Error for OpsDataError {}
type Result<T> = std::result::Result<T, OpsDataError>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OpsAction {
    Status,
    Inspect,
    Selftest,
    WebsiteRestart,
    PruneObserve,
}
impl OpsAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Status => "reverie.ops.status",
            Self::Inspect => "reverie.ops.inspect",
            Self::Selftest => "reverie.ops.selftest.run",
            Self::WebsiteRestart => "reverie.ops.website.restart",
            Self::PruneObserve => "reverie.ops.prune.observe",
        }
    }
    pub fn is_effect(self) -> bool {
        !matches!(self, Self::Status | Self::Inspect)
    }
    fn parse(value: &Value) -> Result<Self> {
        let Node::String(text) = &value.0 else {
            return Err(OpsDataError::Shape);
        };
        [
            Self::Status,
            Self::Inspect,
            Self::Selftest,
            Self::WebsiteRestart,
            Self::PruneObserve,
        ]
        .into_iter()
        .find(|action| text.equals_ascii(action.as_str()))
        .ok_or(OpsDataError::Shape)
    }
}

pub struct OpsCommand {
    action: OpsAction,
    bytes: Vec<u8>,
}
impl OpsCommand {
    /// Same strict Python bytes JSON decoder as the protected OPS document,
    /// including encoding detection, duplicate hooks and numeric conversion.
    pub fn decode(raw: &[u8]) -> Result<Self> {
        let value = legacy_json::decode_strict_bytes(raw).map_err(|_| OpsDataError::Json)?;
        let action = validation::command(&value)?;
        Ok(Self {
            action,
            bytes: crate::worker_config::compact_data(&value),
        })
    }
    pub fn status(request: &OpsServiceId, resource: &OpsServiceId) -> Self {
        Self::read(request, resource, None)
    }
    pub fn inspect(
        request: &OpsServiceId,
        resource: &OpsServiceId,
        operation: &OpsServiceId,
    ) -> Self {
        Self::read(request, resource, Some(operation))
    }
    fn read(
        request: &OpsServiceId,
        resource: &OpsServiceId,
        operation: Option<&OpsServiceId>,
    ) -> Self {
        let action = if operation.is_some() {
            OpsAction::Inspect
        } else {
            OpsAction::Status
        };
        let mut fields = BTreeMap::from([
            (key("kind"), string("reverie.ops.command")),
            (
                key("version"),
                Value(Node::Number(Number::Integer("1".into()))),
            ),
            (key("requestId"), string(request.as_str())),
            (key("resourceId"), string(resource.as_str())),
            (key("action"), string(action.as_str())),
        ]);
        if let Some(operation) = operation {
            fields.insert(key("operationId"), string(operation.as_str()));
        }
        Self {
            action,
            bytes: crate::worker_config::compact_data(&Value(Node::Object(fields))),
        }
    }
    pub fn action(&self) -> OpsAction {
        self.action
    }
    pub fn canonical_bytes(&self) -> &[u8] {
        &self.bytes
    }
}

/// A finite server response object. Success retains the original Python truth
/// test; parsing/printing it does not turn a server receipt into native proof.
pub struct OpsReply {
    success: bool,
    bytes: Vec<u8>,
}
impl OpsReply {
    pub fn decode(raw: &[u8]) -> Result<Self> {
        if raw.len() > MAX_REPLY_BYTES {
            return Err(OpsDataError::Bound);
        }
        let value = legacy_json::decode_strict_bytes(raw).map_err(|_| OpsDataError::Json)?;
        let Node::Object(fields) = &value.0 else {
            return Err(OpsDataError::Shape);
        };
        if !value.is_finite() {
            return Err(OpsDataError::Json);
        }
        Ok(Self {
            success: truthy(fields.get(&key("success"))),
            bytes: crate::worker_config::compact_data(&value),
        })
    }
    pub fn succeeded(&self) -> bool {
        self.success
    }
    pub fn canonical_bytes(&self) -> &[u8] {
        &self.bytes
    }
}
fn key(value: &str) -> Text {
    Text(value.chars().map(u32::from).collect())
}
fn string(value: &str) -> Value {
    Value(Node::String(key(value)))
}
