use crate::legacy_json::{Node, Number, Text, Value};
use std::collections::BTreeMap;
use std::fmt::Write;

enum Part<'a> {
    Value(&'a Value),
    Text(&'a Text),
    Literal(&'static str),
}
#[derive(Clone, Copy)]
enum Separators {
    Spaced,
    Compact,
}
impl Separators {
    fn comma(self) -> &'static str {
        match self {
            Self::Spaced => ", ",
            Self::Compact => ",",
        }
    }
    fn colon(self) -> &'static str {
        match self {
            Self::Spaced => ": ",
            Self::Compact => ":",
        }
    }
}
pub(super) fn encode(root: &Value, policy: bool) -> Vec<u8> {
    encode_with(root, policy, Separators::Spaced)
}
pub(super) fn compact(root: &Value) -> Vec<u8> {
    encode_with(root, false, Separators::Compact)
}
fn encode_with(root: &Value, policy: bool, separators: Separators) -> Vec<u8> {
    let mut result = String::new();
    let mut pending = vec![Part::Value(root)];
    while let Some(part) = pending.pop() {
        match part {
            Part::Text(text) => string(text, &mut result),
            Part::Literal(text) => result.push_str(text),
            Part::Value(value) => match &value.0 {
                Node::Null => result.push_str("null"),
                Node::Bool(boolean) => result.push_str(if *boolean { "true" } else { "false" }),
                Node::String(text) => string(text, &mut result),
                Node::Number(Number::Integer(integer)) => result.push_str(integer),
                Node::Number(Number::Float(number)) => result.push_str(&float(*number)),
                Node::Number(Number::Nan) => result.push_str("NaN"),
                Node::Number(Number::PositiveInfinity) => result.push_str("Infinity"),
                Node::Number(Number::NegativeInfinity) => result.push_str("-Infinity"),
                Node::Array(values) => array(values, separators, &mut pending, &mut result),
                Node::Object(values) => object(
                    values,
                    policy && std::ptr::eq(value, root),
                    separators,
                    &mut pending,
                    &mut result,
                ),
            },
        }
    }
    result.into_bytes()
}
fn excluded(key: &Text) -> bool {
    ["image", "maintenanceSessions", "opsConfig"]
        .iter()
        .any(|name| key.equals_ascii(name))
}
fn object<'a>(
    values: &'a BTreeMap<Text, Value>,
    policy: bool,
    separators: Separators,
    pending: &mut Vec<Part<'a>>,
    result: &mut String,
) {
    result.push('{');
    pending.push(Part::Literal("}"));
    let selected: Vec<_> = values
        .iter()
        .filter(|(key, _)| !policy || !excluded(key))
        .collect();
    for (index, (key, value)) in selected.into_iter().enumerate().rev() {
        pending.push(Part::Value(value));
        pending.push(Part::Literal(separators.colon()));
        pending.push(Part::Text(key));
        if index > 0 {
            pending.push(Part::Literal(separators.comma()));
        }
    }
}
fn array<'a>(
    values: &'a [Value],
    separators: Separators,
    pending: &mut Vec<Part<'a>>,
    result: &mut String,
) {
    result.push('[');
    pending.push(Part::Literal("]"));
    for (index, value) in values.iter().enumerate().rev() {
        pending.push(Part::Value(value));
        if index > 0 {
            pending.push(Part::Literal(separators.comma()));
        }
    }
}
fn string(text: &Text, result: &mut String) {
    result.push('"');
    for &codepoint in &text.0 {
        match codepoint {
            8 => result.push_str("\\b"),
            9 => result.push_str("\\t"),
            10 => result.push_str("\\n"),
            12 => result.push_str("\\f"),
            13 => result.push_str("\\r"),
            34 => result.push_str("\\\""),
            92 => result.push_str("\\\\"),
            32..=126 => result.push(char::from_u32(codepoint).expect("ASCII")),
            0..=0xffff => {
                write!(result, "\\u{codepoint:04x}").expect("String write");
            }
            _ => {
                let scalar = codepoint - 0x10000;
                write!(
                    result,
                    "\\u{:04x}\\u{:04x}",
                    0xd800 + (scalar >> 10),
                    0xdc00 + (scalar & 0x3ff)
                )
                .expect("String write");
            }
        }
    }
    result.push('"');
}
// Rust Debug provides shortest round-trip digits, including integral floats and
// signed zero. Python uses a signed, at-least-two-digit exponent at the same
// display thresholds; no JSON number is passed through a lossy Value conversion.
fn float(value: f64) -> String {
    let text = format!("{value:?}");
    let Some((mantissa, exponent)) = text.split_once('e') else {
        return text;
    };
    let exponent: i32 = exponent.parse().expect("finite Debug exponent");
    format!("{mantissa}e{exponent:+03}")
}
