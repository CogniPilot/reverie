//! One-shot legacy broker replies in Python's default `json.dumps` form:
//! `", "` and `": "` separators, ASCII escapes (surrogate pairs above U+FFFF)
//! and insertion order. Only null, booleans, integers, strings, arrays and
//! objects can be built, so no reply can carry a non-finite number.
#[cfg(test)]
mod tests;
use crate::legacy_json::{Node, Number, Text, Value, ordered::OrderedValue};

pub struct BrokerReply(OrderedValue);
impl BrokerReply {
    /// Named observation readers may retain finite structured metadata. This
    /// private boundary never admits NaN/infinity or exposes an unchecked reply.
    pub(crate) fn observation_data(value: &Value) -> Option<Self> {
        value
            .is_finite()
            .then(|| Self(OrderedValue::scalar(value.deep_clone())))
    }
    pub fn null() -> Self {
        Self(OrderedValue::scalar(Value(Node::Null)))
    }
    pub fn boolean(value: bool) -> Self {
        Self(OrderedValue::scalar(Value(Node::Bool(value))))
    }
    pub fn integer(value: i64) -> Self {
        Self(OrderedValue::scalar(Value(Node::Number(Number::Integer(
            value.to_string(),
        )))))
    }
    pub fn string(value: &str) -> Self {
        Self(OrderedValue::scalar(Value(Node::String(text(value)))))
    }
    pub fn array(items: Vec<Self>) -> Self {
        Self(OrderedValue::array(
            items.into_iter().map(|i| i.0).collect(),
        ))
    }
    /// Fields in reply order. A repeated key keeps its first position and the
    /// later value, as a Python dict literal does.
    pub fn object(fields: Vec<(&str, Self)>) -> Self {
        Self(OrderedValue::object(
            fields
                .into_iter()
                .map(|(key, value)| (text(key), value.0))
                .collect(),
        ))
    }
    /// The exact bytes of `json.dumps(reply)`.
    pub fn encode(&self) -> Vec<u8> {
        self.0.encode()
    }
}
fn text(value: &str) -> Text {
    Text(value.chars().map(u32::from).collect())
}
