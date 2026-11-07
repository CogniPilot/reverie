//! `cleanup/collector.py` as data: configuration, readings parsers, the
//! prune-run join, rollups and the exact JSON bytes of every record. The
//! filesystem, clock and subprocess effects live in `reverie-observations`.
mod config;
mod readings;
mod rollup;
mod summary;
#[cfg(test)]
mod tests;

pub use config::{Config, parse_config};
pub use readings::{
    Gpu, GpuDevice, cpu_pct, cpu_times, loadavg, memory, nvidia_devices, python_float, python_int,
};
pub use rollup::{
    CalendarError, RollFiles, Roller, Unencodable, Window, day_file, retention_end, rollup,
    sample_name,
};
pub use summary::{Ledger, PruneJoin, PruneRead, join_prune_runs};

use crate::legacy_json::{self, Node, Number, Text, Value};
use crate::python_number::PythonNumber;
use crate::worker_config::{python_float_repr, python_json_string};
use std::collections::BTreeMap;

/// Python `round(x, 2)`.
pub fn round2(value: f64) -> f64 {
    crate::python_number::round(value, 2)
}

/// One JSON value to write, with Python's int/float distinction.
#[derive(Clone, Debug, PartialEq)]
pub enum Out {
    Null,
    Bool(bool),
    /// Exact decimal digits of a Python `int`.
    Int(String),
    Float(f64),
    /// Python `str` code points.
    Text(Vec<u32>),
    List(Vec<Out>),
    Map(BTreeMap<Vec<u32>, Out>),
}

impl Out {
    pub fn int(value: impl ToString) -> Self {
        Self::Int(value.to_string())
    }
    pub fn text(value: &str) -> Self {
        Self::Text(value.chars().map(u32::from).collect())
    }
    /// A map from ASCII or Unicode keys.
    pub fn map<'a>(entries: impl IntoIterator<Item = (&'a str, Out)>) -> Self {
        Self::Map(
            entries
                .into_iter()
                .map(|(key, value)| (points(key), value))
                .collect(),
        )
    }
    /// Insert or replace one key of a map value.
    pub fn set(&mut self, key: &str, value: Out) {
        if let Self::Map(map) = self {
            map.insert(points(key), value);
        }
    }
    fn number(number: PythonNumber) -> Self {
        match number {
            PythonNumber::Int(value) => Self::int(value),
            PythonNumber::Float(value) => Self::Float(value),
        }
    }
}

/// `json.dumps(obj, separators=(",", ":"), sort_keys=True, allow_nan=False)`.
/// `None` where Python raises `ValueError` for a non-finite float.
pub fn dump(value: &Out) -> Option<String> {
    let mut text = String::new();
    write(value, &mut text)?;
    Some(text)
}

fn write(value: &Out, text: &mut String) -> Option<()> {
    match value {
        Out::Null => text.push_str("null"),
        Out::Bool(true) => text.push_str("true"),
        Out::Bool(false) => text.push_str("false"),
        Out::Int(digits) => text.push_str(digits),
        Out::Float(value) if value.is_finite() => text.push_str(&python_float_repr(*value)),
        Out::Float(_) => return None,
        Out::Text(points) => python_json_string(&Text(points.clone()), text),
        Out::List(values) => {
            text.push('[');
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    text.push(',');
                }
                write(value, text)?;
            }
            text.push(']');
        }
        Out::Map(values) => {
            text.push('{');
            for (index, (key, value)) in values.iter().enumerate() {
                if index > 0 {
                    text.push(',');
                }
                python_json_string(&Text(key.clone()), text);
                text.push(':');
                write(value, text)?;
            }
            text.push('}');
        }
    }
    Some(())
}

fn points(text: &str) -> Vec<u32> {
    text.chars().map(u32::from).collect()
}

/// A decoded record of a history file (`json.loads` of one line).
pub struct Record(Value);

impl Record {
    fn get(&self, key: &str) -> Option<&Value> {
        field(&self.0, key)
    }
    /// The record as it would be written again.
    pub fn out(&self) -> Out {
        copy(&self.0)
    }
    /// `record.get(key)` as a finite Python number.
    fn finite(&self, key: &str) -> Option<PythonNumber> {
        finite(self.get(key))
    }
    /// `int(record.get(key))` for a finite number (truncating floats).
    pub fn whole(&self, key: &str) -> Option<i64> {
        self.finite(key).and_then(truncate)
    }
}

/// `str.splitlines()` of decoded text: also `\v`, `\f`, `\x1c`-`\x1e`,
/// `\x85`, U+2028 and U+2029.
pub fn splitlines(text: &str) -> Vec<&str> {
    let breaks = |c: char| {
        matches!(
            c,
            '\n' | '\r'
                | '\u{0b}'
                | '\u{0c}'
                | '\u{1c}'
                | '\u{1d}'
                | '\u{1e}'
                | '\u{85}'
                | '\u{2028}'
                | '\u{2029}'
        )
    };
    let mut lines = Vec::new();
    let mut rest = text;
    while !rest.is_empty() {
        match rest.find(breaks) {
            Some(at) => {
                lines.push(&rest[..at]);
                let width = if rest[at..].starts_with("\r\n") {
                    2
                } else {
                    rest[at..].chars().next().map_or(1, char::len_utf8)
                };
                rest = &rest[at + width..];
            }
            None => {
                lines.push(rest);
                break;
            }
        }
    }
    lines
}

/// `(records, malformed)` of one history file's text: blank lines are
/// skipped, and a line that is not a JSON object is counted.
pub fn records(text: &str) -> (Vec<Record>, usize) {
    let mut found = Vec::new();
    let mut malformed = 0;
    for line in splitlines(text) {
        if line.trim().is_empty() {
            continue;
        }
        match legacy_json::decode_text(line) {
            Ok(value) if matches!(value.0, Node::Object(_)) => found.push(Record(value)),
            _ => malformed += 1,
        }
    }
    (found, malformed)
}

fn field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    match &value.0 {
        Node::Object(map) => map.get(&Text(points(key))),
        _ => None,
    }
}

fn number(value: Option<&Value>) -> Option<PythonNumber> {
    value.and_then(PythonNumber::of)
}

/// `finite(x)`: an int or float (never a bool) that is finite.
fn finite(value: Option<&Value>) -> Option<PythonNumber> {
    number(value).filter(|number| number.is_finite())
}

#[allow(clippy::cast_possible_truncation)]
fn truncate(number: PythonNumber) -> Option<i64> {
    match number {
        PythonNumber::Int(value) => i64::try_from(value).ok(),
        PythonNumber::Float(value) if value.abs() < 9.0e18 => Some(value.trunc() as i64),
        PythonNumber::Float(_) => None,
    }
}

fn text_of(value: Option<&Value>) -> Option<&[u32]> {
    match value.map(|value| &value.0) {
        Some(Node::String(text)) => Some(&text.0),
        _ => None,
    }
}

fn copy(value: &Value) -> Out {
    match &value.0 {
        Node::Null => Out::Null,
        Node::Bool(flag) => Out::Bool(*flag),
        Node::String(text) => Out::Text(text.0.clone()),
        Node::Number(Number::Integer(digits)) => Out::Int(digits.clone()),
        Node::Number(Number::Float(value)) => Out::Float(*value),
        Node::Number(Number::Nan) => Out::Float(f64::NAN),
        Node::Number(Number::PositiveInfinity) => Out::Float(f64::INFINITY),
        Node::Number(Number::NegativeInfinity) => Out::Float(f64::NEG_INFINITY),
        Node::Array(values) => Out::List(values.iter().map(copy).collect()),
        Node::Object(values) => Out::Map(
            values
                .iter()
                .map(|(key, value)| (key.0.clone(), copy(value)))
                .collect(),
        ),
    }
}

/// `state.json`: only cursors, rewritten whole with any other keys kept.
pub struct State(Value);

impl State {
    /// `json.loads(read_small(state))`, or `{}` when unreadable or not a dict.
    pub fn from_text(text: Option<&str>) -> Self {
        match text.map(legacy_json::decode_text) {
            Some(Ok(value)) if matches!(value.0, Node::Object(_)) => Self(value),
            _ => Self(Value(Node::Object(BTreeMap::new()))),
        }
    }
    /// `state.get("cpu")` when it is a list of two finite non-negative numbers.
    pub fn cpu(&self) -> Option<(f64, f64)> {
        let Some(Value(Node::Array(values))) = field(&self.0, "cpu") else {
            return None;
        };
        let numbers = values
            .iter()
            .map(|value| finite(Some(value)).filter(|number| !number.lt(PythonNumber::Int(0))))
            .collect::<Option<Vec<_>>>()?;
        match numbers[..] {
            [total, idle] => Some((total.float(), idle.float())),
            _ => None,
        }
    }
    fn cursor(&self, window: Window) -> Option<PythonNumber> {
        number(field(&self.0, window.key()))
    }
    /// The state as written, with the given keys replaced.
    pub fn updated(&self, entries: impl IntoIterator<Item = (&'static str, Out)>) -> Out {
        let mut out = copy(&self.0);
        for (key, value) in entries {
            out.set(key, value);
        }
        out
    }
}
