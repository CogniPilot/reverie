//! runtime.json's one legacy read-side field. This is lossless path DATA, not a
//! confined path, file ownership, completion receipt or permission to effects.
use super::*;
use crate::storage_identity::MetadataText;

pub struct LaunchRuntimeData {
    exit: MetadataText,
}
impl LaunchRuntimeData {
    /// Source read_text is UTF8 followed by json.loads(str), not a bytes JSON
    /// decoder. Keep last-wins fields and the existing Python text parser.
    pub fn decode_read_text(raw: &[u8]) -> Result<Self, LaptopReadError> {
        let root = legacy_json::decode_python_str(raw).map_err(|_| LaptopReadError::Json)?;
        let Value(Node::String(exit)) = field(&root, "exit")? else {
            return Err(LaptopReadError::Structure);
        };
        Ok(Self {
            exit: MetadataText::from_text(exit.clone()),
        })
    }
    pub fn exit(&self) -> &MetadataText {
        &self.exit
    }
}
