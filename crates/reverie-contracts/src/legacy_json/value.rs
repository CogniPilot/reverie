use std::collections::BTreeMap;

/// Python sorts strings by Unicode codepoint, including escaped lone surrogates.
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub(crate) struct Text(pub(crate) Vec<u32>);
impl Text {
    pub(crate) fn equals_ascii(&self, value: &str) -> bool {
        self.0.iter().copied().eq(value.bytes().map(u32::from))
    }
}
pub(crate) enum Number {
    Integer(String),
    Float(f64),
    Nan,
    PositiveInfinity,
    NegativeInfinity,
}
pub(crate) enum Node {
    Null,
    Bool(bool),
    String(Text),
    Number(Number),
    Array(Vec<Value>),
    Object(BTreeMap<Text, Value>),
}
pub(crate) struct Value(pub(crate) Node);
pub(crate) fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value(Node::Null | Node::Bool(false))) => false,
        Some(Value(Node::Number(Number::Integer(value)))) => value != "0",
        Some(Value(Node::Number(Number::Float(value)))) => *value != 0.0,
        Some(Value(Node::String(value))) => !value.0.is_empty(),
        Some(Value(Node::Array(value))) => !value.is_empty(),
        Some(Value(Node::Object(value))) => !value.is_empty(),
        _ => true,
    }
}

// Disabled rootlessDocker admits otherwise unconstrained JSON slots. Iterative
// parsing, encoding and destruction avoid adding a shallow compatibility limit.
impl Drop for Value {
    fn drop(&mut self) {
        let mut pending = vec![std::mem::replace(&mut self.0, Node::Null)];
        while let Some(node) = pending.pop() {
            match node {
                Node::Array(values) => append_nodes(values, &mut pending),
                Node::Object(values) => append_nodes(values.into_values(), &mut pending),
                _ => {}
            }
        }
    }
}
fn append_nodes(values: impl IntoIterator<Item = Value>, pending: &mut Vec<Node>) {
    for mut value in values {
        pending.push(std::mem::replace(&mut value.0, Node::Null));
    }
}
