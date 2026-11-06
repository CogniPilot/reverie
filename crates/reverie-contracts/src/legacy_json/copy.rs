//! Python deepcopy of parsed JSON data, without serialization or recursive stack.
use super::{Node, Number, Text, Value};

enum Step<'a> {
    Value(&'a Value),
    Array(usize),
    Object(Vec<Text>),
}
impl Value {
    pub(crate) fn deep_clone(&self) -> Self {
        let mut pending = vec![Step::Value(self)];
        let mut copied = Vec::new();
        while let Some(step) = pending.pop() {
            match step {
                Step::Value(value) => copy_node(value, &mut pending, &mut copied),
                Step::Array(count) => {
                    let children = copied.split_off(copied.len() - count);
                    copied.push(Value(Node::Array(children)));
                }
                Step::Object(keys) => {
                    let values = copied.split_off(copied.len() - keys.len());
                    copied.push(Value(Node::Object(keys.into_iter().zip(values).collect())));
                }
            }
        }
        debug_assert_eq!(copied.len(), 1);
        copied.pop().expect("one copied JSON root")
    }
}
fn copy_node<'a>(value: &'a Value, pending: &mut Vec<Step<'a>>, copied: &mut Vec<Value>) {
    let scalar = match &value.0 {
        Node::Null => Node::Null,
        Node::Bool(value) => Node::Bool(*value),
        Node::String(value) => Node::String(value.clone()),
        Node::Number(value) => Node::Number(number(value)),
        Node::Array(values) => {
            pending.push(Step::Array(values.len()));
            pending.extend(values.iter().rev().map(Step::Value));
            return;
        }
        Node::Object(values) => {
            pending.push(Step::Object(values.keys().cloned().collect()));
            pending.extend(values.values().rev().map(Step::Value));
            return;
        }
    };
    copied.push(Value(scalar));
}
fn number(value: &Number) -> Number {
    match value {
        Number::Integer(value) => Number::Integer(value.clone()),
        Number::Float(value) => Number::Float(*value),
        Number::Nan => Number::Nan,
        Number::PositiveInfinity => Number::PositiveInfinity,
        Number::NegativeInfinity => Number::NegativeInfinity,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn copy_preserves_unpaired_codepoints_and_all_numeric_variants() {
        let values = vec![
            Value(Node::String(Text(vec![0xd800, 0xdc00]))),
            Value(Node::Number(Number::Float(-0.0))),
            Value(Node::Number(Number::Integer("9007199254740993".into()))),
            Value(Node::Number(Number::Nan)),
            Value(Node::Number(Number::PositiveInfinity)),
            Value(Node::Number(Number::NegativeInfinity)),
        ];
        let original = Value(Node::Array(values));
        let copy = original.deep_clone();
        assert!(original.python_eq(&copy));
        let Node::Array(values) = &copy.0 else {
            panic!("array")
        };
        let Node::String(text) = &values[0].0 else {
            panic!("string")
        };
        assert_eq!(text.0, [0xd800, 0xdc00]);
        let Node::Number(Number::Float(value)) = &values[1].0 else {
            panic!("float")
        };
        assert_eq!(value.to_bits(), (-0.0_f64).to_bits());
    }
    #[test]
    fn ten_thousand_nested_containers_clone_compare_and_drop_without_recursion() {
        let mut original = Value(Node::String(Text(vec![0xd800, 0xdc00])));
        for index in 0..10_000 {
            original = if index % 2 == 0 {
                Value(Node::Array(vec![original]))
            } else {
                Value(Node::Object(
                    [(Text(vec![u32::from(b'k')]), original)]
                        .into_iter()
                        .collect(),
                ))
            };
        }
        let copy = original.deep_clone();
        assert!(original.python_eq(&copy));
        drop(original);
        drop(copy);
    }
}
