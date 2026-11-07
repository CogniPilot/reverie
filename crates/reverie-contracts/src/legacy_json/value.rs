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
impl Number {
    pub(super) fn nonfinite_name(&self) -> Option<&'static str> {
        match self {
            Self::Nan => Some("nan"),
            Self::PositiveInfinity => Some("inf"),
            Self::NegativeInfinity => Some("-inf"),
            Self::Float(value) if value.is_nan() => Some("nan"),
            Self::Float(value) if *value == f64::INFINITY => Some("inf"),
            Self::Float(value) if *value == f64::NEG_INFINITY => Some("-inf"),
            _ => None,
        }
    }
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
impl Value {
    pub(crate) fn is_finite(&self) -> bool {
        self.first_nonfinite().is_none()
    }
    /// First refusal for the existing Python sort_keys=True encoder.
    pub(crate) fn first_nonfinite(&self) -> Option<&'static str> {
        let mut pending = vec![self];
        while let Some(value) = pending.pop() {
            match &value.0 {
                Node::Number(number) if number.nonfinite_name().is_some() => {
                    return number.nonfinite_name();
                }
                Node::Array(values) => pending.extend(values.iter().rev()),
                Node::Object(values) => pending.extend(values.values().rev()),
                _ => {}
            }
        }
        None
    }
}
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
