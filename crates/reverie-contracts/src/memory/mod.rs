//! Named existing SQLite memory fields and outward memory records. Arbitrary
//! legacy metadata remains data; there is no public general JSON editor.
mod embedding;
mod fields;
mod history;
use crate::legacy_json::ordered::OrderedValue;
use crate::legacy_json::{Node, Number, Text, Value};
use crate::storage_identity::MetadataText;
pub use embedding::{
    EmbeddingContractError, EmbeddingResponse, decode_embedding_text, embedding_model_name,
    embedding_text, encode_embedding_request, encode_embedding_request_text,
};
pub use fields::{MemoryMetadata, MemorySources};
pub use history::{LegacyEpisode, LegacyHistory};
use std::fmt;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MemoryJsonError {
    InvalidJson,
    ExpectedObject,
    ExpectedHistoryTurn,
    ExpectedHistoryText,
    InvalidCodepoint,
    ExpectedSourcesIterable,
}
impl fmt::Display for MemoryJsonError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for MemoryJsonError {}
type Result<T> = std::result::Result<T, MemoryJsonError>;
#[derive(Clone)]
pub struct Memory {
    pub id: i64,
    pub kind: String,
    pub created_at: f64,
    pub user_text: String,
    pub assistant_text: String,
    pub text: String,
    pub importance: f64,
    pub importance_source: String,
    pub embed_model: String,
    pub embedding: Vec<f64>,
    pub source_ids: MemorySources,
    pub section: String,
    pub meta: MemoryMetadata,
    pub last_accessed: Option<f64>,
    pub score: f64,
}
pub struct MemoryView(Vec<u8>);
impl MemoryView {
    pub fn as_json(&self) -> &[u8] {
        &self.0
    }
}
impl Memory {
    pub fn as_dict(&self) -> MemoryView {
        MemoryView(self.as_dict_json())
    }
    pub fn is_idle(&self) -> Result<bool> {
        self.meta.idle()
    }
    pub fn recall(&self) -> Result<MetadataText> {
        self.meta.recall(&self.text)
    }
    pub fn as_dict_json(&self) -> Vec<u8> {
        object(vec![
            ("id", integer(self.id)),
            ("kind", string(&self.kind)),
            ("created_at", float(self.created_at)),
            ("user_text", string(&self.user_text)),
            ("assistant_text", string(&self.assistant_text)),
            ("text", string(&self.text)),
            ("importance", float(self.importance)),
            ("importance_source", string(&self.importance_source)),
            ("embed_model", string(&self.embed_model)),
            ("source_ids", self.source_ids.0.clone()),
            ("section", string(&self.section)),
            ("meta", self.meta.0.clone()),
            ("last_accessed", self.last_accessed.map_or_else(null, float)),
            ("score", float(self.score)),
        ])
        .encode()
    }
}
fn text(raw: &str) -> Text {
    Text(raw.chars().map(u32::from).collect())
}
fn string(raw: &str) -> OrderedValue {
    OrderedValue::scalar(Value(Node::String(text(raw))))
}
fn integer(raw: i64) -> OrderedValue {
    OrderedValue::scalar(Value(Node::Number(Number::Integer(raw.to_string()))))
}
fn float(raw: f64) -> OrderedValue {
    OrderedValue::scalar(Value(Node::Number(Number::Float(raw))))
}
fn boolean(raw: bool) -> OrderedValue {
    OrderedValue::scalar(Value(Node::Bool(raw)))
}
fn null() -> OrderedValue {
    OrderedValue::scalar(Value(Node::Null))
}
fn object(fields: Vec<(&str, OrderedValue)>) -> OrderedValue {
    OrderedValue::object(
        fields
            .into_iter()
            .map(|(name, value)| (text(name), value))
            .collect(),
    )
}
