use super::Text;
use super::{Node, Number, Value};
use std::collections::BTreeMap;
type Comparison<'a> = (&'a Value, &'a Value, bool);

/// Python set/equality identity for JSON numeric scalars. Finite integral
/// floats become their exact decimal integer, not a lossy integer-to-f64 cast.
pub(crate) fn numeric_key(value: &Node) -> Option<String> {
    let key = match value {
        Node::Bool(value) => {
            if *value {
                "1".into()
            } else {
                "0".into()
            }
        }
        Node::Number(Number::Integer(value)) => value.clone(),
        Node::Number(Number::Float(value)) if value.fract() == 0.0 => format!("{value:.0}"),
        Node::Number(Number::Float(value)) => format!("f{:016x}", value.to_bits()),
        Node::Number(Number::Nan) => "nan".into(),
        Node::Number(Number::PositiveInfinity) => "inf".into(),
        Node::Number(Number::NegativeInfinity) => "-inf".into(),
        _ => return None,
    };
    Some(if key == "-0" { "0".into() } else { key })
}
impl Value {
    /// Equality of values returned by Python json.loads, including numeric
    /// bool/int/float comparisons. Python's decoder reuses its NaN singleton:
    /// NaN scalar == NaN is false, but matching container elements compare equal
    /// via Python's identity shortcut. This is data comparison, not hash encoding.
    pub(crate) fn python_eq(&self, other: &Self) -> bool {
        let mut pending = vec![(self, other, false)];
        while let Some((left, right, nested)) = pending.pop() {
            if !compare(left, right, nested, &mut pending) {
                return false;
            }
        }
        true
    }
}
fn compare<'a>(
    left: &'a Value,
    right: &'a Value,
    nested: bool,
    pending: &mut Vec<Comparison<'a>>,
) -> bool {
    match (&left.0, &right.0) {
        (Node::Null, Node::Null) => true,
        (Node::String(left), Node::String(right)) if left == right => true,
        (Node::Number(Number::Nan), Node::Number(Number::Nan)) if nested => true,
        (Node::Number(Number::Nan), _) | (_, Node::Number(Number::Nan)) => false,
        (Node::Array(left), Node::Array(right)) if left.len() == right.len() => {
            pending.extend(left.iter().zip(right).map(|(a, b)| (a, b, true)));
            true
        }
        (Node::Object(left), Node::Object(right)) if left.len() == right.len() => {
            objects(left, right, pending)
        }
        (left, right) => {
            matches!((numeric_key(left),numeric_key(right)),(Some(left),Some(right)) if left==right)
        }
    }
}
fn objects<'a>(
    left: &'a BTreeMap<Text, Value>,
    right: &'a BTreeMap<Text, Value>,
    pending: &mut Vec<Comparison<'a>>,
) -> bool {
    for ((left_key, left), (right_key, right)) in left.iter().zip(right) {
        if left_key != right_key {
            return false;
        }
        pending.push((left, right, true));
    }
    true
}
