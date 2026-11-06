//! Fixed-purpose private worker-child record reader. This is not the public
//! request codec: the broker adds PATH/NIX_* fields after request validation.
use crate::legacy_json::{self, Node, Text, Value, ordered::OrderNode};
use reverie_core::{
    PythonText,
    worker_child::{ChildEnvironmentValue, TemporaryEnvironmentRoot},
};
use sha2::{Digest, Sha256};
mod encode;
pub use encode::encode_launch_record;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChildDataError {
    Json,
    Environment,
    Directory,
    Command,
}
impl std::fmt::Display for ChildDataError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(out, "{self:?}")
    }
}
impl std::error::Error for ChildDataError {}
/// Keep fields lazy to preserve read/decode -> unlink -> env -> cwd -> relay
/// construction -> chdir -> command lookup/exec ordering of the actual child.
pub struct PrivateChildRecord(legacy_json::ordered::OrderedValue);
impl PrivateChildRecord {
    /// Path.read_text universal newlines followed by default json.loads(str).
    /// No bytes BOM detector or arbitrary global file/depth cap is inserted.
    pub fn decode(raw: &[u8]) -> Result<Self, ChildDataError> {
        let raw = std::str::from_utf8(raw)
            .map_err(|_| ChildDataError::Json)?
            .replace("\r\n", "\n")
            .replace('\r', "\n");
        legacy_json::decode_private_child_text(raw.as_bytes())
            .map(Self)
            .map_err(|_| ChildDataError::Json)
    }
    pub fn requested_environment(
        &self,
    ) -> Result<Vec<(PythonText, ChildEnvironmentValue)>, ChildDataError> {
        let Some(value) = self.field("env") else {
            return Err(ChildDataError::Environment);
        };
        let Node::Object(values) = &value.0 else {
            return Err(ChildDataError::Environment);
        };
        let index = self
            .0
            .root_child_index(&key("env"))
            .expect("parsed field order");
        let OrderNode::Object(order) = &self.0.graph.nodes[index] else {
            unreachable!("object order companion");
        };
        Ok(order
            .iter()
            .map(|(name, _)| {
                let value = match &values.get(name).expect("parsed object order").0 {
                    Node::String(value) => ChildEnvironmentValue::Text(points(value)),
                    _ => ChildEnvironmentValue::Other,
                };
                (points(name), value)
            })
            .collect())
    }
    /// Null selects the source's global temporary defaults. It still fails at
    /// the later native chdir phase, after relay construction, rather than
    /// changing earlier environment/relay ordering.
    pub fn directory(&self) -> Result<Option<PythonText>, ChildDataError> {
        match self.field("cwd") {
            Some(Value(Node::Null)) => Ok(None),
            Some(Value(Node::String(text))) => Ok(Some(points(text))),
            _ => Err(ChildDataError::Directory),
        }
    }
    pub fn command(&self) -> Result<PythonText, ChildDataError> {
        self.text("command", ChildDataError::Command)
    }
    fn field(&self, name: &str) -> Option<&Value> {
        if let Node::Object(values) = &self.0.value.0 {
            values.get(&key(name))
        } else {
            None
        }
    }
    fn text(&self, name: &str, error: ChildDataError) -> Result<PythonText, ChildDataError> {
        match self.field(name) {
            Some(Value(Node::String(text))) => Ok(points(text)),
            _ => Err(error),
        }
    }
}
fn key(value: &str) -> Text {
    Text(value.chars().map(u32::from).collect())
}
fn points(value: &Text) -> PythonText {
    PythonText::try_new(value.0.clone()).expect("JSON parser produces Python codepoints")
}
pub fn project_temporary_root(raw_cwd_bytes: &[u8]) -> TemporaryEnvironmentRoot {
    let hash = Sha256::digest(raw_cwd_bytes);
    TemporaryEnvironmentRoot::project(hash[..12].try_into().expect("SHA256 width"))
}
