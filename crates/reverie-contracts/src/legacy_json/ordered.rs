//! Private insertion-order companion to the shared lossless value. Flat
//! indices keep building and emitting iterative. Only the objects and scalars
//! that ordered writers build, emitted as default `json.dumps` (ASCII).
use super::{Node, Text, Value};
use std::collections::BTreeMap;
pub(crate) enum OrderNode {
    Leaf,
    Object(Vec<(Text, usize)>),
}
pub(crate) struct OrderGraph {
    pub(crate) nodes: Vec<OrderNode>,
    pub(crate) root: usize,
}
pub(crate) struct OrderedValue {
    pub(crate) value: Value,
    pub(crate) graph: OrderGraph,
}
impl OrderedValue {
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
    pub(crate) fn encode(&self) -> Vec<u8> {
        encode(self)
            .0
            .into_iter()
            .map(|cp| u8::try_from(cp).expect("ASCII JSON"))
            .collect()
    }
}
fn graft(target: &mut Vec<OrderNode>, child: OrderedValue) -> (Value, usize) {
    let offset = target.len();
    for node in child.graph.nodes {
        target.push(match node {
            OrderNode::Leaf => OrderNode::Leaf,
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
fn encode(source: &OrderedValue) -> Text {
    let mut output = Vec::new();
    let mut pending = vec![Piece::Value(&source.value, source.graph.root)];
    while let Some(piece) = pending.pop() {
        match piece {
            Piece::Raw(raw) => output.extend(raw.iter().copied().map(u32::from)),
            Piece::Text(text) => emit_text(text, &mut output),
            Piece::Value(value, index) => match (&value.0, &source.graph.nodes[index]) {
                (Node::Object(values), OrderNode::Object(order)) => {
                    push_object(values, order, &mut pending, &mut output);
                }
                (Node::String(text), OrderNode::Leaf) => emit_text(text, &mut output),
                (_, OrderNode::Leaf) => emit_scalar(value, &mut output),
                _ => unreachable!("private order companion matches its value"),
            },
        }
    }
    Text(output)
}
fn push_object<'a>(
    values: &'a BTreeMap<Text, Value>,
    order: &'a [(Text, usize)],
    pending: &mut Vec<Piece<'a>>,
    output: &mut Vec<u32>,
) {
    assert_eq!(values.len(), order.len(), "private object order");
    output.push(123);
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
fn emit_text(text: &Text, output: &mut Vec<u32>) {
    output.extend(crate::worker_config::quoted_text(text, true).0);
}
fn emit_scalar(value: &Value, output: &mut Vec<u32>) {
    output.extend(
        crate::worker_config::encode_data(value)
            .into_iter()
            .map(u32::from),
    );
}
