use super::Error;
use super::value::{Node, Number, Text, Value};
use serde_json::value::RawValue;
use std::collections::BTreeMap;
mod journal;
mod ordered;
use super::ordered::OrderNode;
pub(crate) use journal::{JournalParseError, JournalParsed};

#[derive(Clone, Copy, Eq, PartialEq)]
pub(super) enum Purpose {
    Default,
    NoConstants,
    Rootless,
    Journal,
    StrictEngine,
    Metadata,
}

enum Phase {
    First,
    Value,
    Colon,
    Next,
}
enum Frame {
    Array {
        values: Vec<Value>,
        phase: Phase,
        order: Option<Vec<usize>>,
    },
    Object {
        values: BTreeMap<Text, Value>,
        key: Option<Text>,
        phase: Phase,
        duplicate: bool,
        order: Option<Vec<Text>>,
        children: Option<BTreeMap<Text, usize>>,
    },
}
enum Action {
    Ready(Value),
    Push(Frame),
    Close,
    Continue,
}
struct Cursor<'a> {
    source: &'a [u8],
    offset: usize,
    purpose: Purpose,
    journal_error: Option<JournalParseError>,
    root_object_orders: BTreeMap<Text, Vec<Text>>,
    orders: Option<Vec<OrderNode>>,
    ready_order: Option<usize>,
    constant_refusal: bool,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum GpuControlParseError {
    Json(Error),
    Nonfinite,
}
pub(super) fn decode_gpu_control(source: &[u8]) -> Result<Value, GpuControlParseError> {
    let mut cursor = Cursor::new(source, Purpose::StrictEngine);
    finish(&mut cursor).map_err(|error| {
        if cursor.constant_refusal {
            GpuControlParseError::Nonfinite
        } else {
            GpuControlParseError::Json(error)
        }
    })
}

pub(super) fn decode(source: &[u8]) -> Result<Value, Error> {
    decode_mode(source, Purpose::Default)
}
pub(super) fn decode_without_constants(source: &[u8]) -> Result<Value, Error> {
    decode_mode(source, Purpose::NoConstants)
}
pub(super) fn decode_last_wins(source: &[u8]) -> Result<Value, Error> {
    decode_mode(source, Purpose::Rootless)
}
pub(super) fn decode_engine_stopped(source: &[u8]) -> Result<Value, Error> {
    decode_mode(source, Purpose::StrictEngine)
}
pub(super) fn decode_metadata(source: &[u8]) -> Result<Value, Error> {
    decode_mode(source, Purpose::Metadata)
}
pub(super) fn decode_journal(source: &[u8]) -> Result<JournalParsed, JournalParseError> {
    journal::decode(source)
}
pub(super) fn decode_ordered(
    source: &[u8],
    purpose: Purpose,
) -> Result<super::ordered::OrderedValue, Error> {
    ordered::decode(source, purpose)
}
fn decode_mode(source: &[u8], purpose: Purpose) -> Result<Value, Error> {
    finish(&mut Cursor::new(source, purpose))
}
fn finish(cursor: &mut Cursor<'_>) -> Result<Value, Error> {
    let root = parse(cursor)?;
    cursor.whitespace();
    if cursor.offset != cursor.source.len() {
        return Err(Error::InvalidJson);
    }
    Ok(root)
}
impl<'a> Cursor<'a> {
    fn new(source: &'a [u8], purpose: Purpose) -> Self {
        Self {
            source,
            offset: 0,
            purpose,
            journal_error: None,
            root_object_orders: BTreeMap::new(),
            orders: None,
            ready_order: None,
            constant_refusal: false,
        }
    }
}
fn parse(cursor: &mut Cursor<'_>) -> Result<Value, Error> {
    let mut frames: Vec<Frame> = Vec::new();
    let mut action = cursor.start()?;
    loop {
        match action {
            Action::Ready(value) => match frames.last_mut() {
                Some(frame) => frame.attach(value, cursor)?,
                None => return Ok(value),
            },
            Action::Push(frame) => frames.push(frame),
            Action::Close => {
                let value = frames
                    .pop()
                    .ok_or(Error::InvalidJson)?
                    .close(cursor, &frames)?;
                action = Action::Ready(value);
                continue;
            }
            Action::Continue => {}
        }
        action = frames.last_mut().ok_or(Error::InvalidJson)?.step(cursor)?;
    }
}
impl Frame {
    fn attach(&mut self, value: Value, cursor: &mut Cursor<'_>) -> Result<(), Error> {
        match self {
            Self::Array {
                values,
                phase,
                order,
            } => {
                if let Some(order) = order {
                    order.push(cursor.ready_order.take().ok_or(Error::InvalidJson)?);
                }
                values.push(value);
                *phase = Phase::Next;
            }
            Self::Object {
                values,
                key,
                phase,
                duplicate,
                order,
                children,
            } => {
                let key = key.take().ok_or(Error::InvalidJson)?;
                if let Some(order) = order
                    && (cursor.purpose == Purpose::Journal || !values.contains_key(&key))
                {
                    order.push(key.clone());
                }
                if let Some(children) = children {
                    children.insert(
                        key.clone(),
                        cursor.ready_order.take().ok_or(Error::InvalidJson)?,
                    );
                }
                let previous = values.insert(key, value);
                if previous.is_some() {
                    *duplicate = duplicate_value(cursor.purpose)?;
                }
                *phase = Phase::Next;
            }
        }
        Ok(())
    }
    fn close(self, cursor: &mut Cursor<'_>, parents: &[Frame]) -> Result<Value, Error> {
        match self {
            Self::Array { values, order, .. } => {
                if let Some(order) = order {
                    cursor.capture_order(OrderNode::Array(order));
                }
                Ok(Value(Node::Array(values)))
            }
            Self::Object {
                values,
                duplicate,
                order,
                children,
                ..
            } => {
                if duplicate {
                    return Err(Error::DuplicateKey);
                }
                if cursor.purpose == Purpose::Journal
                    && let (
                        Some(order),
                        [
                            Frame::Object {
                                key: Some(parent), ..
                            },
                        ],
                    ) = (order.as_ref(), parents)
                {
                    cursor
                        .root_object_orders
                        .insert(parent.clone(), order.clone());
                }
                if let Some(children) = children {
                    let order = ordered::object_order(order, children)?;
                    cursor.capture_order(OrderNode::Object(order));
                }
                Ok(Value(Node::Object(values)))
            }
        }
    }
    fn step(&mut self, cursor: &mut Cursor<'_>) -> Result<Action, Error> {
        cursor.whitespace();
        match self {
            Self::Array { phase, .. } => match phase {
                Phase::First if cursor.take(b']') => Ok(Action::Close),
                Phase::First | Phase::Value => cursor.start(),
                Phase::Next => next(cursor, b']', phase),
                Phase::Colon => Err(Error::InvalidJson),
            },
            Self::Object { key, phase, .. } => match phase {
                Phase::First if cursor.take(b'}') => Ok(Action::Close),
                Phase::First | Phase::Value => {
                    *key = Some(cursor.string()?);
                    *phase = Phase::Colon;
                    Ok(Action::Continue)
                }
                Phase::Colon => {
                    if !cursor.take(b':') {
                        return Err(Error::InvalidJson);
                    }
                    cursor.start()
                }
                Phase::Next => next(cursor, b'}', phase),
            },
        }
    }
}
fn duplicate_value(purpose: Purpose) -> Result<bool, Error> {
    match purpose {
        Purpose::Rootless => Ok(false),
        Purpose::Journal | Purpose::StrictEngine | Purpose::Metadata => Ok(true),
        _ => Err(Error::DuplicateKey),
    }
}
fn next(cursor: &mut Cursor<'_>, closing: u8, phase: &mut Phase) -> Result<Action, Error> {
    if cursor.take(closing) {
        return Ok(Action::Close);
    }
    if !cursor.take(b',') {
        return Err(Error::InvalidJson);
    }
    *phase = Phase::Value;
    Ok(Action::Continue)
}
impl Cursor<'_> {
    fn whitespace(&mut self) {
        while self
            .source
            .get(self.offset)
            .is_some_and(|b| b" \n\t\r".contains(b))
        {
            self.offset += 1;
        }
    }
    fn take(&mut self, byte: u8) -> bool {
        if self.source.get(self.offset) == Some(&byte) {
            self.offset += 1;
            true
        } else {
            false
        }
    }
    fn start(&mut self) -> Result<Action, Error> {
        self.whitespace();
        let action = match self.source.get(self.offset) {
            Some(b'{') => {
                self.offset += 1;
                Action::Push(Frame::Object {
                    values: BTreeMap::new(),
                    key: None,
                    phase: Phase::First,
                    duplicate: false,
                    order: (self.purpose == Purpose::Journal || self.orders.is_some())
                        .then(Vec::new),
                    children: self.orders.is_some().then(BTreeMap::new),
                })
            }
            Some(b'[') => {
                self.offset += 1;
                Action::Push(Frame::Array {
                    values: Vec::new(),
                    phase: Phase::First,
                    order: self.orders.is_some().then(Vec::new),
                })
            }
            Some(b'"') => {
                let value = Value(Node::String(self.string()?));
                self.scalar(value)
            }
            Some(b't') => self.literal("true", Node::Bool(true))?,
            Some(b'f') => self.literal("false", Node::Bool(false))?,
            Some(b'n') => self.literal("null", Node::Null)?,
            Some(b'N' | b'I')
                if matches!(self.purpose, Purpose::NoConstants | Purpose::StrictEngine) =>
            {
                self.constant_refusal = self.source[self.offset..].starts_with(b"NaN")
                    || self.source[self.offset..].starts_with(b"Infinity");
                return Err(Error::InvalidJson);
            }
            Some(b'N') => self.literal("NaN", Node::Number(Number::Nan))?,
            Some(b'I') => self.literal("Infinity", Node::Number(Number::PositiveInfinity))?,
            Some(b'-' | b'0'..=b'9') => {
                let value = Value(Node::Number(self.number()?));
                self.scalar(value)
            }
            _ => return Err(Error::InvalidJson),
        };
        Ok(action)
    }
    fn literal(&mut self, literal: &str, node: Node) -> Result<Action, Error> {
        if !self.source[self.offset..].starts_with(literal.as_bytes()) {
            return Err(Error::InvalidJson);
        }
        if self.purpose == Purpose::Journal && matches!(literal, "NaN" | "Infinity") {
            return self.journal_failure(JournalParseError::JsonNumber);
        }
        self.offset += literal.len();
        Ok(self.scalar(Value(node)))
    }
    fn number(&mut self) -> Result<Number, Error> {
        if self.purpose == Purpose::Journal {
            return journal::number(self);
        }
        let begin = self.offset;
        if self.source[begin..].starts_with(b"-Infinity") {
            if matches!(self.purpose, Purpose::NoConstants | Purpose::StrictEngine) {
                self.constant_refusal = true;
                return Err(Error::InvalidJson);
            }
            self.offset += "-Infinity".len();
            return Ok(Number::NegativeInfinity);
        }
        if matches!(self.purpose, Purpose::StrictEngine | Purpose::Metadata) {
            self.offset = journal::number_end(self.source, begin).ok_or(Error::InvalidJson)?;
        } else {
            while self
                .source
                .get(self.offset)
                .is_some_and(|b| b"0123456789-+.eE".contains(b))
            {
                self.offset += 1;
            }
        }
        let text = std::str::from_utf8(&self.source[begin..self.offset])
            .map_err(|_| Error::InvalidJson)?;
        serde_json::from_str::<&RawValue>(text).map_err(|_| Error::InvalidJson)?;
        if !text.contains(['.', 'e', 'E']) {
            // The rootless-purpose default Python decoder uses its runtime's
            // decimal conversion cap even for ignored/overwritten fields.
            // Other named readers keep their separately frozen number policy.
            if matches!(
                self.purpose,
                Purpose::Rootless | Purpose::StrictEngine | Purpose::Metadata
            ) && text.strip_prefix('-').unwrap_or(text).len() > super::DEFAULT_INT_MAX_DIGITS
            {
                return Err(Error::InvalidJson);
            }
            return Ok(Number::Integer(
                if text == "-0" { "0" } else { text }.to_owned(),
            ));
        }
        let value: f64 = text.parse().map_err(|_| Error::InvalidJson)?;
        if value == f64::INFINITY {
            return Ok(Number::PositiveInfinity);
        }
        if value == f64::NEG_INFINITY {
            return Ok(Number::NegativeInfinity);
        }
        Ok(Number::Float(value))
    }
    fn string(&mut self) -> Result<Text, Error> {
        if !self.take(b'"') {
            return Err(Error::InvalidJson);
        }
        let mut result = Vec::new();
        loop {
            let (character, width) = super::text::codepoint(&self.source[self.offset..])?;
            self.offset += width;
            match character {
                34 => return Ok(Text(result)),
                92 => result.push(self.escape()?),
                0..=31 => return Err(Error::InvalidJson),
                _ => result.push(character),
            }
        }
    }
    fn escape(&mut self) -> Result<u32, Error> {
        let byte = *self.source.get(self.offset).ok_or(Error::InvalidJson)?;
        self.offset += 1;
        match byte {
            b'"' | b'\\' | b'/' => Ok(u32::from(byte)),
            b'b' => Ok(8),
            b'f' => Ok(12),
            b'n' => Ok(10),
            b'r' => Ok(13),
            b't' => Ok(9),
            b'u' => self.unicode_escape(),
            _ => Err(Error::InvalidJson),
        }
    }
    fn unicode_escape(&mut self) -> Result<u32, Error> {
        let high = self.hex_unit()?;
        if !(0xd800..=0xdbff).contains(&high) || !self.source[self.offset..].starts_with(b"\\u") {
            return Ok(high);
        }
        let previous = self.offset;
        self.offset += 2;
        let low = self.hex_unit()?;
        if (0xdc00..=0xdfff).contains(&low) {
            return Ok(0x10000 + ((high - 0xd800) << 10) + low - 0xdc00);
        }
        self.offset = previous;
        Ok(high)
    }
    fn hex_unit(&mut self) -> Result<u32, Error> {
        let bytes = self
            .source
            .get(self.offset..self.offset + 4)
            .ok_or(Error::InvalidJson)?;
        let mut value = 0;
        for &byte in bytes {
            value = value * 16 + char::from(byte).to_digit(16).ok_or(Error::InvalidJson)?;
        }
        self.offset += 4;
        Ok(value)
    }
}
