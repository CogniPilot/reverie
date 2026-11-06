use super::*;
use crate::legacy_json::{self, ordered::OrderNode};
use reverie_core::memory::{EmbeddingError, parse_embedding_float_text};
#[derive(Debug)]
pub enum EmbeddingContractError {
    InvalidJson,
    Shape,
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
    let mut fields = vec![("input", string(input))];
    if !model.is_empty() {
        fields.push(("model", string(model)));
    }
    object(fields).encode()
}
