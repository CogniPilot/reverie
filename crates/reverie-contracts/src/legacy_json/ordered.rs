//! Private insertion-order companion to the shared lossless value/parser.
//! Flat indices keep parsing, copying, emitting and destruction iterative.
use super::{Node, Number, Text, Value};
use std::collections::BTreeMap;
#[derive(Clone)]
pub(crate) enum OrderNode {
    Leaf,
    Array(Vec<usize>),
    Object(Vec<(Text, usize)>),
}
#[derive(Clone)]
pub(crate) struct OrderGraph {
    pub(crate) nodes: Vec<OrderNode>,
    pub(crate) root: usize,
}
impl OrderGraph {
    pub(crate) fn with_root(&self, root: usize) -> Self {
        Self {
            nodes: self.nodes.clone(),
            root,
        }
    }
}
pub(crate) struct OrderedValue {
    pub(crate) value: Value,
    pub(crate) graph: OrderGraph,
}
impl Clone for OrderedValue {
    fn clone(&self) -> Self {
        Self {
            value: self.value.deep_clone(),
            graph: self.graph.clone(),
        }
    }
}
impl OrderedValue {
    pub(crate) fn root_child_index(&self, key: &Text) -> Option<usize> {
        let OrderNode::Object(order) = &self.graph.nodes[self.graph.root] else {
            return None;
        };
        order
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, index)| *index)
    }
    pub(crate) fn scalar(value: Value) -> Self {
        Self {
            value,
            graph: OrderGraph {
                nodes: vec![OrderNode::Leaf],
                root: 0,
            },
        }
    }
    pub(crate) fn object(fields: Vec<(Text, Self)>) -> Self {
        let mut nodes = Vec::new();
        let mut order = Vec::new();
        let mut values = BTreeMap::new();
        for (key, child) in fields {
            let (value, index) = graft(&mut nodes, child);
            if let Some((_, old)) = order.iter_mut().find(|(name, _)| name == &key) {
                *old = index;
            } else {
                order.push((key.clone(), index));
            }
            values.insert(key, value);
        }
        let root = nodes.len();
        nodes.push(OrderNode::Object(order));
        Self {
            value: Value(Node::Object(values)),
            graph: OrderGraph { nodes, root },
        }
    }
    pub(crate) fn array(children: Vec<Self>) -> Self {
        let mut nodes = Vec::new();
        let mut values = Vec::new();
        let mut order = Vec::new();
        for child in children {
            let (value, index) = graft(&mut nodes, child);
            values.push(value);
            order.push(index);
        }
        let root = nodes.len();
        nodes.push(OrderNode::Array(order));
        Self {
            value: Value(Node::Array(values)),
            graph: OrderGraph { nodes, root },
        }
    }
    pub(crate) fn insert_root_field(&mut self, key: Text, value: Value) -> bool {
        let Node::Object(values) = &mut self.value.0 else {
            return false;
        };
        let index = self.graph.nodes.len();
        self.graph.nodes.push(OrderNode::Leaf);
        let OrderNode::Object(order) = &mut self.graph.nodes[self.graph.root] else {
            unreachable!("private object graph")
        };
        if let Some((_, old)) = order.iter_mut().find(|(name, _)| name == &key) {
            *old = index;
        } else {
            order.push((key.clone(), index));
        }
        values.insert(key, value);
        true
    }
    pub(crate) fn encode(&self) -> Vec<u8> {
        encode(self, false)
    }
    pub(crate) fn python_string(&self) -> Text {
        if let Node::String(value) = &self.value.0 {
            return value.clone();
        }
        Text(
            String::from_utf8(encode(self, true))
                .expect("repr output is scalar UTF8")
                .chars()
                .map(u32::from)
                .collect(),
        )
    }
}
fn graft(target: &mut Vec<OrderNode>, child: OrderedValue) -> (Value, usize) {
    let offset = target.len();
    for node in child.graph.nodes {
        target.push(match node {
            OrderNode::Leaf => OrderNode::Leaf,
            OrderNode::Array(order) => {
                OrderNode::Array(order.into_iter().map(|i| i + offset).collect())
            }
            OrderNode::Object(order) => OrderNode::Object(
                order
                    .into_iter()
                    .map(|(key, i)| (key, i + offset))
                    .collect(),
            ),
        });
    }
    (child.value, child.graph.root + offset)
}
enum Piece<'a> {
    Value(&'a Value, usize),
    Text(&'a Text),
    Raw(&'static [u8]),
}
fn encode(source: &OrderedValue, repr: bool) -> Vec<u8> {
    let mut output = Vec::new();
    let mut pending = vec![Piece::Value(&source.value, source.graph.root)];
    while let Some(piece) = pending.pop() {
        match piece {
            Piece::Raw(raw) => output.extend_from_slice(raw),
            Piece::Text(text) => emit_text(text, repr, &mut output),
            Piece::Value(value, index) => match (&value.0, &source.graph.nodes[index]) {
                (Node::Array(values), OrderNode::Array(order)) => {
                    push_array(values, order, &mut pending, &mut output);
                }
                (Node::Object(values), OrderNode::Object(order)) => {
                    push_object(values, order, &mut pending, &mut output);
                }
                (Node::String(text), OrderNode::Leaf) => emit_text(text, repr, &mut output),
                (_, OrderNode::Leaf) => emit_scalar(value, repr, &mut output),
                _ => unreachable!("private order companion matches its value"),
            },
        }
    }
    output
}
fn push_array<'a>(
    values: &'a [Value],
    order: &[usize],
    pending: &mut Vec<Piece<'a>>,
    output: &mut Vec<u8>,
) {
    assert_eq!(values.len(), order.len(), "private array order");
    output.push(b'[');
    pending.push(Piece::Raw(b"]"));
    for (at, (value, &index)) in values.iter().zip(order).enumerate().rev() {
        pending.push(Piece::Value(value, index));
        if at > 0 {
            pending.push(Piece::Raw(b", "));
        }
    }
}
fn push_object<'a>(
    values: &'a BTreeMap<Text, Value>,
    order: &'a [(Text, usize)],
    pending: &mut Vec<Piece<'a>>,
    output: &mut Vec<u8>,
) {
    assert_eq!(values.len(), order.len(), "private object order");
    output.push(b'{');
    pending.push(Piece::Raw(b"}"));
    for (at, (key, index)) in order.iter().enumerate().rev() {
        pending.push(Piece::Value(
            values.get(key).expect("private ordered key"),
            *index,
        ));
        pending.push(Piece::Raw(b": "));
        pending.push(Piece::Text(key));
        if at > 0 {
            pending.push(Piece::Raw(b", "));
        }
    }
}
fn emit_text(text: &Text, repr: bool, output: &mut Vec<u8>) {
    if repr {
        output.extend_from_slice(
            reverie_core::memory::quoted_memory_text(&text.0)
                .expect("checked JSON codepoints")
                .as_bytes(),
        );
    } else {
        output.extend_from_slice(&crate::worker_config::encode_data(&Value(Node::String(
            text.clone(),
        ))));
    }
}
fn emit_scalar(value: &Value, repr: bool, output: &mut Vec<u8>) {
    let literal = if repr {
        match &value.0 {
            Node::Null => Some("None"),
            Node::Bool(true) => Some("True"),
            Node::Bool(false) => Some("False"),
            Node::Number(Number::Nan) => Some("nan"),
            Node::Number(Number::PositiveInfinity) => Some("inf"),
            Node::Number(Number::NegativeInfinity) => Some("-inf"),
            Node::Number(Number::Float(value)) if value.is_nan() => Some("nan"),
            Node::Number(Number::Float(value)) if *value == f64::INFINITY => Some("inf"),
            Node::Number(Number::Float(value)) if *value == f64::NEG_INFINITY => Some("-inf"),
            _ => None,
        }
    } else {
        None
    };
    if let Some(literal) = literal {
        output.extend_from_slice(literal.as_bytes());
    } else {
        output.extend_from_slice(&crate::worker_config::encode_data(value));
    }
}
