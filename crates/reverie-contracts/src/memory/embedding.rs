use super::*;
use crate::legacy_json::{self, ordered::OrderNode};
use reverie_core::memory::{EmbeddingError, parse_embedding_float_text};
#[derive(Debug)]
pub enum EmbeddingContractError {
    InvalidJson,
    Shape,
    InvalidText,
    Number(EmbeddingError),
}
impl fmt::Display for EmbeddingContractError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for EmbeddingContractError {}
pub struct EmbeddingResponse {
    vector: OrderedValue,
    dimensions: usize,
}
impl EmbeddingResponse {
    pub fn decode(raw: &[u8]) -> std::result::Result<Self, EmbeddingContractError> {
        let document = legacy_json::decode_embedding_bytes(raw)
            .map_err(|_| EmbeddingContractError::InvalidJson)?;
        let data = child(&document.value, "data")?;
        let Node::Array(data) = &data.0 else {
            return Err(EmbeddingContractError::Shape);
        };
        let first = data.first().ok_or(EmbeddingContractError::Shape)?;
        let value = child(first, "embedding")?;
        let dimensions = match &value.0 {
            Node::Array(v) => v.len(),
            Node::Object(v) => v.len(),
            Node::String(v) => v.0.len(),
            _ => return Err(EmbeddingContractError::Shape),
        };
        let data_index = document
            .root_child_index(&text("data"))
            .ok_or(EmbeddingContractError::Shape)?;
        let OrderNode::Array(data_order) = &document.graph.nodes[data_index] else {
            return Err(EmbeddingContractError::Shape);
        };
        let first_index = *data_order.first().ok_or(EmbeddingContractError::Shape)?;
        let OrderNode::Object(first_order) = &document.graph.nodes[first_index] else {
            return Err(EmbeddingContractError::Shape);
        };
        let index = first_order
            .iter()
            .find(|(key, _)| key.equals_ascii("embedding"))
            .map(|(_, index)| *index)
            .ok_or(EmbeddingContractError::Shape)?;
        Ok(Self {
            vector: OrderedValue {
                value: value.deep_clone(),
                graph: document.graph.with_root(index),
            },
            dimensions,
        })
    }
    /// Assigned by the backend before float coercion, matching its source.
    pub fn dimensions(&self) -> usize {
        self.dimensions
    }
    pub fn vector(&self) -> std::result::Result<Vec<f64>, EmbeddingContractError> {
        let values: std::result::Result<Vec<f64>, EmbeddingError> = match &self.vector.value.0 {
            Node::Array(values) => values.iter().map(number).collect(),
            Node::String(value) => value
                .0
                .iter()
                .map(|&cp| parse_embedding_float_text(&[cp]))
                .collect(),
            Node::Object(_) => {
                let OrderNode::Object(order) = &self.vector.graph.nodes[self.vector.graph.root]
                else {
                    unreachable!("private embedding object")
                };
                order
                    .iter()
                    .map(|(key, _)| parse_embedding_float_text(&key.0))
                    .collect()
            }
            _ => unreachable!("closed vector shape"),
        };
        values.map_err(EmbeddingContractError::Number)
    }
}
fn child<'a>(
    value: &'a Value,
    name: &str,
) -> std::result::Result<&'a Value, EmbeddingContractError> {
    let Node::Object(fields) = &value.0 else {
        return Err(EmbeddingContractError::Shape);
    };
    fields.get(&text(name)).ok_or(EmbeddingContractError::Shape)
}
fn number(value: &Value) -> std::result::Result<f64, EmbeddingError> {
    match &value.0 {
        Node::Bool(value) => Ok(f64::from(u8::from(*value))),
        Node::Number(Number::Float(value)) => Ok(*value),
        Node::Number(Number::Nan) => Ok(f64::NAN),
        Node::Number(Number::PositiveInfinity) => Ok(f64::INFINITY),
        Node::Number(Number::NegativeInfinity) => Ok(f64::NEG_INFINITY),
        Node::Number(Number::Integer(value)) => {
            let value = value
                .parse::<f64>()
                .map_err(|_| EmbeddingError::InvalidNumber)?;
            if value.is_infinite() {
                Err(EmbeddingError::InvalidNumber)
            } else {
                Ok(value)
            }
        }
        Node::String(value) => parse_embedding_float_text(&value.0),
        _ => Err(EmbeddingError::InvalidNumber),
    }
}
pub fn encode_embedding_request(input: &str, model: &str) -> Vec<u8> {
    encode_embedding_request_text(
        &MetadataText::from_scalar_text(input),
        &MetadataText::from_scalar_text(model),
    )
}
pub fn encode_embedding_request_text(input: &MetadataText, model: &MetadataText) -> Vec<u8> {
    let mut fields = vec![("input", codepoint_string(input))];
    if !model.codepoints().is_empty() {
        fields.push(("model", codepoint_string(model)));
    }
    object(fields).encode()
}
pub(super) fn codepoint_string(input: &MetadataText) -> OrderedValue {
    OrderedValue::scalar(Value(Node::String(Text(input.codepoints().to_vec()))))
}
pub fn embedding_text(input: reverie_core::memory::EmbeddingText<'_>) -> MetadataText {
    MetadataText::from_python_text(input.as_python_text_ref().into_owned())
}
pub fn embedding_model_name(model: &MetadataText) -> MetadataText {
    let mut name = "llama:".chars().map(u32::from).collect::<Vec<_>>();
    if model.codepoints().is_empty() {
        name.extend("default".chars().map(u32::from));
    } else {
        name.extend_from_slice(model.codepoints());
    }
    MetadataText::from_text(Text(name))
}
/// Named embedding input/model string decoder. This is data, not provider or
/// owner approval; raw WTF8/UTF16/32 bytes retain their original codepoints.
pub fn decode_embedding_text(
    raw: &[u8],
) -> std::result::Result<MetadataText, EmbeddingContractError> {
    let mut document = legacy_json::decode_embedding_bytes(raw)
        .map_err(|_| EmbeddingContractError::InvalidJson)?;
    match std::mem::replace(&mut document.value.0, Node::Null) {
        Node::String(text) => Ok(MetadataText::from_text(text)),
        _ => Err(EmbeddingContractError::Shape),
    }
}
