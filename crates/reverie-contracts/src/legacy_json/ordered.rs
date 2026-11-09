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
    pub(crate) fn overlay_object(&mut self, overlay: &Self) -> bool {
        let (Node::Object(values), Node::Object(other)) = (&mut self.value.0, &overlay.value.0)
        else {
            return false;
        };
        let OrderNode::Object(order) = &overlay.graph.nodes[overlay.graph.root] else {
            unreachable!("private overlay object graph");
        };
        let offset = self.graph.nodes.len();
        for node in &overlay.graph.nodes {
            self.graph.nodes.push(match node {
                OrderNode::Leaf => OrderNode::Leaf,
                OrderNode::Array(indices) => {
                    OrderNode::Array(indices.iter().map(|i| i + offset).collect())
                }
                OrderNode::Object(fields) => OrderNode::Object(
                    fields
                        .iter()
                        .map(|(key, i)| (key.clone(), i + offset))
                        .collect(),
                ),
            });
        }
        let OrderNode::Object(target) = &mut self.graph.nodes[self.graph.root] else {
            unreachable!("private target object graph");
        };
        for (key, index) in order {
            values.insert(
                key.clone(),
                other.get(key).expect("private overlay key").deep_clone(),
            );
            if let Some((_, old)) = target.iter_mut().find(|(name, _)| name == key) {
                *old = index + offset;
            } else {
                target.push((key.clone(), index + offset));
            }
        }
        true
    }
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
        self.ascii(Format::Ascii)
    }
    pub(crate) fn encode_compact(&self) -> Vec<u8> {
        self.ascii(Format::AsciiCompact)
    }
    pub(crate) fn encode_utf16_sorted(&self) -> Vec<u8> {
        self.ascii(Format::AsciiUtf16Sorted)
    }
    /// First refusal for Python's insertion-ordered allow_nan=False encoder.
    pub(crate) fn first_nonfinite(&self) -> Option<&'static str> {
        let mut pending = vec![(&self.value, self.graph.root)];
        while let Some((value, index)) = pending.pop() {
            match (&value.0, &self.graph.nodes[index]) {
                (Node::Number(number), OrderNode::Leaf) if number.nonfinite_name().is_some() => {
                    return number.nonfinite_name();
                }
                (Node::Array(values), OrderNode::Array(order)) => {
                    pending.extend(values.iter().zip(order).rev().map(|(v, i)| (v, *i)));
                }
                (Node::Object(values), OrderNode::Object(order)) => {
                    pending.extend(
                        order
                            .iter()
                            .rev()
                            .map(|(key, i)| (values.get(key).expect("private JSON order"), *i)),
                    );
                }
                _ => (),
            }
        }
        None
    }
    fn ascii(&self, format: Format) -> Vec<u8> {
        encode(self, format)
            .0
            .into_iter()
            .map(|cp| u8::try_from(cp).expect("ASCII JSON"))
            .collect()
    }
    pub(crate) fn unicode_text(&self, sorted_compact: bool) -> Text {
        encode(
            self,
            if sorted_compact {
                Format::UnicodeSortedCompact
            } else {
                Format::UnicodeSpaced
            },
        )
    }
    pub(crate) fn python_string(&self) -> Text {
        if let Node::String(value) = &self.value.0 {
            return value.clone();
        }
        encode(self, Format::Repr)
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
#[derive(Clone, Copy)]
enum Format {
    Ascii,
    AsciiCompact,
    AsciiUtf16Sorted,
    Repr,
    UnicodeSpaced,
    UnicodeSortedCompact,
}
impl Format {
    fn comma(self) -> &'static [u8] {
        if matches!(
            self,
            Self::UnicodeSortedCompact | Self::AsciiCompact | Self::AsciiUtf16Sorted
        ) {
            b","
        } else {
            b", "
        }
    }
    fn colon(self) -> &'static [u8] {
        if matches!(
            self,
            Self::UnicodeSortedCompact | Self::AsciiCompact | Self::AsciiUtf16Sorted
        ) {
            b":"
        } else {
            b": "
        }
    }
}
fn encode(source: &OrderedValue, format: Format) -> Text {
    let mut output = Vec::new();
    let mut pending = vec![Piece::Value(&source.value, source.graph.root)];
    while let Some(piece) = pending.pop() {
        match piece {
            Piece::Raw(raw) => output.extend(raw.iter().copied().map(u32::from)),
            Piece::Text(text) => emit_text(text, format, &mut output),
            Piece::Value(value, index) => match (&value.0, &source.graph.nodes[index]) {
                (Node::Array(values), OrderNode::Array(order)) => {
                    push_array(values, order, &mut pending, &mut output, format);
                }
                (Node::Object(values), OrderNode::Object(order)) => {
                    push_object(values, order, &mut pending, &mut output, format);
                }
                (Node::String(text), OrderNode::Leaf) => emit_text(text, format, &mut output),
                (_, OrderNode::Leaf) => {
                    emit_scalar(value, matches!(format, Format::Repr), &mut output)
                }
                _ => unreachable!("private order companion matches its value"),
            },
        }
    }
    Text(output)
}
fn push_array<'a>(
    values: &'a [Value],
    order: &[usize],
    pending: &mut Vec<Piece<'a>>,
    output: &mut Vec<u32>,
    format: Format,
) {
    assert_eq!(values.len(), order.len(), "private array order");
    output.push(91);
    pending.push(Piece::Raw(b"]"));
    for (at, (value, &index)) in values.iter().zip(order).enumerate().rev() {
        pending.push(Piece::Value(value, index));
        if at > 0 {
            pending.push(Piece::Raw(format.comma()));
        }
    }
}
fn push_object<'a>(
    values: &'a BTreeMap<Text, Value>,
    order: &'a [(Text, usize)],
    pending: &mut Vec<Piece<'a>>,
    output: &mut Vec<u32>,
    format: Format,
) {
    assert_eq!(values.len(), order.len(), "private object order");
    output.push(123);
    pending.push(Piece::Raw(b"}"));
    let mut selected = order.iter().collect::<Vec<_>>();
    if matches!(format, Format::UnicodeSortedCompact) {
        selected.sort_by(|a, b| a.0.cmp(&b.0));
    }
    if matches!(format, Format::AsciiUtf16Sorted) {
        selected.sort_by_cached_key(|(text, _)| {
            reverie_core::PythonTextRef::from_codepoints(&text.0)
                .expect("checked JSON text")
                .utf16_units()
        });
    }
    for (at, (key, index)) in selected.into_iter().enumerate().rev() {
        pending.push(Piece::Value(
            values.get(key).expect("private ordered key"),
            *index,
        ));
        pending.push(Piece::Raw(format.colon()));
        pending.push(Piece::Text(key));
        if at > 0 {
            pending.push(Piece::Raw(format.comma()));
        }
    }
}
fn emit_text(text: &Text, format: Format, output: &mut Vec<u32>) {
    if matches!(format, Format::Repr) {
        output.extend(
            reverie_core::memory::quoted_memory_text(&text.0)
                .expect("checked JSON codepoints")
                .chars()
                .map(u32::from),
        );
    } else {
        output.extend(
            crate::worker_config::quoted_text(
                text,
                matches!(
                    format,
                    Format::Ascii | Format::AsciiCompact | Format::AsciiUtf16Sorted
                ),
            )
            .0,
        );
    }
}
fn emit_scalar(value: &Value, repr: bool, output: &mut Vec<u32>) {
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
        output.extend(literal.chars().map(u32::from));
    } else {
        output.extend(
            crate::worker_config::encode_data(value)
                .into_iter()
                .map(u32::from),
        );
    }
}
