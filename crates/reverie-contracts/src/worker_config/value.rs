use std::collections::BTreeMap;

/// Python sorts strings by Unicode codepoint, including escaped lone surrogates.
#[derive(Eq, PartialEq, Ord, PartialOrd)]
pub(super) struct Text(pub(super) Vec<u32>);
impl Text {
    pub(super) fn equals_ascii(&self, value: &str) -> bool {
        self.0.iter().copied().eq(value.bytes().map(u32::from))
    }
}
pub(super) enum Number {
    Integer(String),
    Float(f64),
    Nan,
    PositiveInfinity,
    NegativeInfinity,
}
pub(super) enum Node {
    Null,
    Bool(bool),
    String(Text),
    Number(Number),
    Array(Vec<Value>),
    Object(BTreeMap<Text, Value>),
}
pub(super) struct Value(pub(super) Node);

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
