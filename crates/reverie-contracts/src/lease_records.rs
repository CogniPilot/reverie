//! Exact lease-directory record bytes and reservation liveness from
//! `python/reverie/cleanup/lease.py`. Data only: callers own every file,
//! lock and clock effect. Paths are Python `str` codepoints, so
//! surrogate-escaped host bytes keep their exact `json.dumps` escapes.
use crate::legacy_json::{self, Node, Number, Text, Value, ordered::OrderedValue, truthy};
use std::cmp::Ordering;

/// Longest reservation window, in seconds (`MAX_RESERVE`).
pub const MAX_RESERVE_SECONDS: u32 = 24 * 3600;

/// `_reservation_value_state`: liveness is only a well-formed window.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReservationState {
    Free,
    InUse,
    Unknown,
}

/// A lease-directory metadata file that `_retirement_record` admitted: a
/// JSON object with integer `version` 1 and no duplicate keys.
pub struct LeaseRecord(Value);

/// Why `_retirement_record` refused a payload; the host adds the file checks.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LeaseRecordError {
    /// The duplicate-key hook fired: "duplicate retirement lease metadata".
    Duplicate,
    /// Not Python JSON: "retirement lease metadata unavailable".
    Invalid,
    /// Not an object with integer version 1: "retirement lease metadata malformed".
    Malformed,
}

/// `_path_record`: the registered path, or a malformed record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PathRecord {
    Path(Vec<u32>),
    Malformed,
}

fn text(value: &str) -> Text {
    Text(value.chars().map(u32::from).collect())
}
fn string(points: &[u32]) -> OrderedValue {
    OrderedValue::scalar(Value(Node::String(Text(points.to_vec()))))
}
fn integer(value: impl ToString) -> OrderedValue {
    OrderedValue::scalar(Value(Node::Number(Number::Integer(value.to_string()))))
}
fn float(value: f64) -> OrderedValue {
    OrderedValue::scalar(Value(Node::Number(Number::Float(value))))
}
fn record(fields: Vec<(&str, OrderedValue)>) -> Vec<u8> {
    let mut bytes = OrderedValue::object(
        fields
            .into_iter()
            .map(|(name, value)| (text(name), value))
            .collect(),
    )
    .encode();
    bytes.push(b'\n');
    bytes
}

/// `<key>.path.json`: `{"version": 1, "path": ..., "first_seen_utc": ...}`.
#[must_use]
pub fn path_record_bytes(path: &[u32], first_seen_utc: f64) -> Vec<u8> {
    record(vec![
        ("version", integer(1)),
        ("path", string(path)),
        ("first_seen_utc", float(first_seen_utc)),
    ])
}

/// `<key>.reserve.json`. `until_utc` is Python's `now + length`, a float.
#[must_use]
pub fn reservation_bytes(
    path: &[u32],
    now: f64,
    seconds: u32,
    owner: &[u32],
    compute_lease_id: Option<&[u32]>,
) -> Vec<u8> {
    let mut fields = vec![
        ("version", integer(1)),
        ("path", string(path)),
        ("created_utc", float(now)),
        ("until_utc", float(now + f64::from(seconds))),
        ("owner", string(owner)),
    ];
    if let Some(id) = compute_lease_id.filter(|id| !id.is_empty()) {
        fields.push(("compute_lease_id", string(id)));
    }
    record(fields)
}

/// Fields of one live holder's `<key>.<pid>.json`.
pub struct HolderRecord<'a> {
    pub path: &'a [u32],
    pub pid: u32,
    pub start: Option<u64>,
    pub argv0: &'a [u32],
    pub utc: f64,
    pub session: u32,
}

/// `<key>.<pid>.json` in `hold`'s field order; `start` is null when unread.
#[must_use]
pub fn holder_record_bytes(holder: &HolderRecord<'_>) -> Vec<u8> {
    let start = holder
        .start
        .map_or_else(|| OrderedValue::scalar(Value(Node::Null)), integer);
    record(vec![
        ("version", integer(1)),
        ("path", string(holder.path)),
        ("pid", integer(holder.pid)),
        ("start", start),
        ("argv0", string(holder.argv0)),
        ("utc", float(holder.utc)),
        ("session", integer(holder.session)),
    ])
}

/// `_parse_duration`: `<digits><s|m|h|d>`, more than 0 and at most 24 h.
#[must_use]
pub fn reservation_seconds(text: &str) -> Option<u32> {
    let unit = match text.as_bytes().last()? {
        b's' => 1,
        b'm' => 60,
        b'h' => 3600,
        b'd' => 86400,
        _ => return None,
    };
    let digits = &text[..text.len() - 1];
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    // Python's int() is unbounded; any count past the window is refused anyway.
    let count = digits.trim_start_matches('0');
    let count = if count.is_empty() {
        0
    } else if count.len() > 6 {
        return None;
    } else {
        count.parse::<u32>().ok()?
    };
    let seconds = count.checked_mul(unit)?;
    (seconds > 0 && seconds <= MAX_RESERVE_SECONDS).then_some(seconds)
}

/// `_read_reservation` + `_reservation_value_state` for one file's bytes
/// (`None` when the file is absent). `Path.read_text` + `json.loads(str)`
/// keeps the last duplicate key. Intentional correction: Python treats a
/// file whose whole value is `null` as no reservation (FREE); any
/// non-object value is UNKNOWN here, so a corrupt file never frees a tree.
#[must_use]
pub fn reservation_file_state(raw: Option<&[u8]>, now: f64) -> ReservationState {
    let Some(raw) = raw else {
        return ReservationState::Free;
    };
    read_text_json(raw).map_or(ReservationState::Unknown, |value| value_state(&value, now))
}

/// `Path.read_text` + `json.loads(str)`, keeping the last duplicate key.
fn read_text_json(raw: &[u8]) -> Option<Value> {
    legacy_json::utf8_file_text(raw)
        .and_then(|text| legacy_json::decode_python_str(text.as_bytes()))
        .ok()
}

/// `_path_record` for a present `<key>.path.json`: an object with Python
/// `version == 1` and a string `path`.
#[must_use]
pub fn path_record(raw: &[u8]) -> PathRecord {
    let parsed = read_text_json(raw);
    let Some(Value(Node::Object(fields))) = &parsed else {
        return PathRecord::Malformed;
    };
    match fields.get(&text("path")) {
        Some(Value(Node::String(path))) if python_version_one(fields.get(&text("version"))) => {
            PathRecord::Path(path.0.clone())
        }
        _ => PathRecord::Malformed,
    }
}

/// `_metadata`: a live-holder record counts only as parsed JSON of any shape.
#[must_use]
pub fn holder_record_parses(raw: &[u8]) -> bool {
    read_text_json(raw).is_some()
}

/// `reserve(renew=True)`: the current reservation's string `path`. Python
/// refuses a missing, unparsable or empty file; a truthy non-object crashes
/// there and is refused here.
#[must_use]
pub fn renewable_path(raw: &[u8]) -> Option<Vec<u32>> {
    match &read_text_json(raw)? {
        Value(Node::Object(fields)) => match fields.get(&text("path")) {
            Some(Value(Node::String(path))) => Some(path.0.clone()),
            _ => None,
        },
        _ => None,
    }
}

/// Python `value == 1` for JSON data: 1, 1.0 and true.
#[allow(clippy::float_cmp)]
fn python_version_one(value: Option<&Value>) -> bool {
    match value {
        Some(Value(Node::Number(Number::Integer(digits)))) => integer_value(digits) == Some(1),
        Some(Value(Node::Number(Number::Float(value)))) => *value == 1.0,
        Some(Value(Node::Bool(true))) => true,
        _ => false,
    }
}

impl LeaseRecord {
    /// `_retirement_record`'s payload rule: `json.loads(bytes)` with a
    /// duplicate-refusing hook, an object, and `type(version) is int == 1`.
    pub fn parse(raw: &[u8]) -> Result<Self, LeaseRecordError> {
        let value = legacy_json::decode_metadata_bytes(raw).map_err(|error| match error {
            legacy_json::Error::DuplicateKey => LeaseRecordError::Duplicate,
            legacy_json::Error::InvalidJson => LeaseRecordError::Invalid,
        })?;
        let Node::Object(fields) = &value.0 else {
            return Err(LeaseRecordError::Malformed);
        };
        match fields.get(&text("version")) {
            Some(Value(Node::Number(Number::Integer(version))))
                if integer_value(version) == Some(1) =>
            {
                Ok(Self(value))
            }
            _ => Err(LeaseRecordError::Malformed),
        }
    }
    /// The `path` field when it is a string.
    #[must_use]
    pub fn path(&self) -> Option<&[u32]> {
        match self.field("path") {
            Some(Value(Node::String(path))) => Some(&path.0),
            _ => None,
        }
    }
    /// This record read as a reservation.
    #[must_use]
    pub fn reservation_state(&self, now: f64) -> ReservationState {
        value_state(&self.0, now)
    }
    /// Exact JSON bytes of one numeric field, as Python would re-emit it.
    #[must_use]
    pub fn number_bytes(&self, name: &str) -> Option<Vec<u8>> {
        let Some(Value(Node::Number(number))) = self.field(name) else {
            return None;
        };
        let copied = match number {
            Number::Integer(digits) => Number::Integer(digits.clone()),
            Number::Float(value) => Number::Float(*value),
            Number::Nan => Number::Nan,
            Number::PositiveInfinity => Number::PositiveInfinity,
            Number::NegativeInfinity => Number::NegativeInfinity,
        };
        Some(OrderedValue::scalar(Value(Node::Number(copied))).encode())
    }
    fn field(&self, name: &str) -> Option<&Value> {
        match &self.0.0 {
            Node::Object(fields) => fields.get(&text(name)),
            _ => None,
        }
    }
}

/// A Python `int` or `float` operand of the reservation window checks.
#[derive(Clone, Copy)]
enum Operand {
    Int(i128),
    Float(f64),
}
impl Operand {
    fn of(value: &Value) -> Option<Self> {
        // `type(x) in (int, float)`: booleans are excluded; NaN and the
        // infinities are floats whose comparisons below are all false.
        match &value.0 {
            Node::Number(Number::Integer(digits)) => integer_value(digits).map(Self::Int),
            Node::Number(Number::Float(value)) => Some(Self::Float(*value)),
            Node::Number(Number::Nan) => Some(Self::Float(f64::NAN)),
            Node::Number(Number::PositiveInfinity) => Some(Self::Float(f64::INFINITY)),
            Node::Number(Number::NegativeInfinity) => Some(Self::Float(f64::NEG_INFINITY)),
            _ => None,
        }
    }
    #[allow(clippy::cast_precision_loss)]
    fn float(self) -> f64 {
        // Python's int-to-float conversion also rounds to nearest, ties even.
        match self {
            Self::Int(value) => value as f64,
            Self::Float(value) => value,
        }
    }
    fn minus(self, other: Self) -> Option<Self> {
        match (self, other) {
            (Self::Int(left), Self::Int(right)) => left.checked_sub(right).map(Self::Int),
            _ => Some(Self::Float(self.float() - other.float())),
        }
    }
    /// Python's exact mixed int/float ordering; `None` for NaN.
    fn compare(self, other: Self) -> Option<Ordering> {
        match (self, other) {
            (Self::Int(left), Self::Int(right)) => Some(left.cmp(&right)),
            (Self::Float(left), Self::Float(right)) => left.partial_cmp(&right),
            (Self::Int(left), Self::Float(right)) => int_float(left, right),
            (Self::Float(left), Self::Int(right)) => int_float(right, left).map(Ordering::reverse),
        }
    }
    fn le(self, other: Self) -> bool {
        matches!(self.compare(other), Some(Ordering::Less | Ordering::Equal))
    }
    fn lt(self, other: Self) -> bool {
        matches!(self.compare(other), Some(Ordering::Less))
    }
}

#[allow(clippy::cast_possible_truncation, clippy::float_cmp)]
fn int_float(integer: i128, float: f64) -> Option<Ordering> {
    const LIMIT: f64 = 170_141_183_460_469_231_731_687_303_715_884_105_728.0; // 2^127
    if float.is_nan() {
        return None;
    }
    if float >= LIMIT {
        return Some(Ordering::Less);
    }
    if float < -LIMIT {
        return Some(Ordering::Greater);
    }
    let whole = float.trunc();
    Some(integer.cmp(&(whole as i128)).then(if float > whole {
        Ordering::Less
    } else if float < whole {
        Ordering::Greater
    } else {
        Ordering::Equal
    }))
}

/// Decimal JSON integer text. Integers outside i128 are refused, which only
/// changes absurd far-past windows from Python's FREE to UNKNOWN.
fn integer_value(digits: &str) -> Option<i128> {
    digits.parse().ok()
}

fn value_state(value: &Value, now: f64) -> ReservationState {
    let Node::Object(fields) = &value.0 else {
        return ReservationState::Unknown;
    };
    let get = |name: &str| fields.get(&text(name));
    let version = python_version_one(get("version"));
    let (Some(created), Some(until)) = (
        get("created_utc").and_then(Operand::of),
        get("until_utc").and_then(Operand::of),
    ) else {
        return ReservationState::Unknown;
    };
    let now = Operand::Float(now);
    let maximum = Operand::Int(i128::from(MAX_RESERVE_SECONDS));
    let window = until.minus(created);
    let ok = version
        && !truthy(get("malformed"))
        && window.is_some_and(|window| Operand::Int(0).lt(window) && window.le(maximum))
        && created.le(Operand::Float(now.float() + 60.0))
        && until.minus(now).is_some_and(|left| left.le(maximum));
    if !ok {
        ReservationState::Unknown
    } else if now.lt(until) {
        ReservationState::InUse
    } else {
        ReservationState::Free
    }
}

#[cfg(test)]
mod tests;
