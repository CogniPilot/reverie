use super::*;
use crate::legacy_json::ordered::{OrderGraph, OrderedValue};
pub(super) fn decode(source: &[u8], purpose: Purpose) -> Result<OrderedValue, Error> {
    let mut cursor = Cursor::new(source, purpose);
    with_cursor(&mut cursor)
}
pub(super) fn with_cursor(cursor: &mut Cursor<'_>) -> Result<OrderedValue, Error> {
    cursor.orders = Some(Vec::new());
    let value = finish(cursor)?;
    let root = cursor.ready_order.ok_or(Error::InvalidJson)?;
    let nodes = cursor.orders.take().ok_or(Error::InvalidJson)?;
    Ok(OrderedValue {
        value,
        graph: OrderGraph { nodes, root },
    })
}
impl Cursor<'_> {
    pub(super) fn capture_order(&mut self, node: OrderNode) {
        if let Some(nodes) = &mut self.orders {
            self.ready_order = Some(nodes.len());
            nodes.push(node);
        }
    }
    pub(super) fn scalar(&mut self, value: Value) -> Action {
        self.capture_order(OrderNode::Leaf);
        Action::Ready(value)
    }
}
pub(super) fn object_order(
    order: Option<Vec<Text>>,
    children: BTreeMap<Text, usize>,
) -> Result<Vec<(Text, usize)>, Error> {
    order
        .ok_or(Error::InvalidJson)?
        .into_iter()
        .map(|key| {
            let index = *children.get(&key).ok_or(Error::InvalidJson)?;
            Ok((key, index))
        })
        .collect()
}
