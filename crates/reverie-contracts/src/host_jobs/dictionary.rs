//! Purpose-private Python dict(spec) conversion. Original pair-object order
//! matters even though eventual hashes sort keys; no public JSON editor exists.
use super::*;
use crate::legacy_json::ordered::{OrderGraph, OrderNode};
pub(super) fn capture(value: &Value, graph: &OrderGraph, index: usize) -> Result<Object> {
    match &value.0 {
        Node::Object(fields) => Ok(fields
            .iter()
            .map(|(name, value)| (name.clone(), value.deep_clone()))
            .collect()),
        Node::Array(values) => {
            let OrderNode::Array(order) = &graph.nodes[index] else {
                return Err(HostJobDataError::Spec);
            };
            let mut fields = Object::new();
            for (value, &index) in values.iter().zip(order) {
                let (key, value) = pair(value, graph, index)?;
                fields.insert(key, value);
            }
            Ok(fields)
        }
        _ => Err(HostJobDataError::Spec),
    }
}
fn pair(value: &Value, graph: &OrderGraph, index: usize) -> Result<(Text, Value)> {
    match &value.0 {
        Node::Array(pair) if pair.len() == 2 => {
            let Node::String(name) = &pair[0].0 else {
                return Err(HostJobDataError::Spec);
            };
            Ok((name.clone(), pair[1].deep_clone()))
        }
        Node::Object(_) => {
            let OrderNode::Object(order) = &graph.nodes[index] else {
                return Err(HostJobDataError::Spec);
            };
            if order.len() != 2 {
                return Err(HostJobDataError::Spec);
            }
            Ok((order[0].0.clone(), Value(Node::String(order[1].0.clone()))))
        }
        Node::String(text) if text.0.len() == 2 => Ok((
            Text(vec![text.0[0]]),
            Value(Node::String(Text(vec![text.0[1]]))),
        )),
        _ => Err(HostJobDataError::Spec),
    }
}
