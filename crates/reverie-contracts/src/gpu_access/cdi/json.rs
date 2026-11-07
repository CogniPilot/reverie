use super::*;
pub(super) fn document(value: Value) -> CdiDocument {
    let mut nodes = vec![CdiValue::Atom];
    let mut pending = vec![(0, value)];
    while let Some((index, mut value)) = pending.pop() {
        nodes[index] = match std::mem::replace(&mut value.0, Node::Null) {
            Node::String(value) => CdiValue::Text(MetadataText::from_text(value)),
            Node::Array(values) => CdiValue::List(array(values, &mut nodes, &mut pending)),
            Node::Object(values) => CdiValue::Map(object(values, &mut nodes, &mut pending)),
            _ => CdiValue::Atom,
        };
    }
    CdiDocument { nodes, root: 0 }
}
fn allocate(value: Value, nodes: &mut Vec<CdiValue>, pending: &mut Vec<(usize, Value)>) -> usize {
    let child = nodes.len();
    nodes.push(CdiValue::Atom);
    pending.push((child, value));
    child
}
fn array(
    values: Vec<Value>,
    nodes: &mut Vec<CdiValue>,
    pending: &mut Vec<(usize, Value)>,
) -> Vec<usize> {
    values
        .into_iter()
        .map(|value| allocate(value, nodes, pending))
        .collect()
}
fn object(
    values: Object,
    nodes: &mut Vec<CdiValue>,
    pending: &mut Vec<(usize, Value)>,
) -> BTreeMap<MetadataText, usize> {
    values
        .into_iter()
        .map(|(name, value)| {
            (
                MetadataText::from_text(name),
                allocate(value, nodes, pending),
            )
        })
        .collect()
}
