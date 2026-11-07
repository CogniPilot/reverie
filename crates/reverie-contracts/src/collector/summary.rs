//! `validate_summary`, `ledger` and `new_prune_runs`: the authoritative
//! prune-run join, keyed by run id and bounded per sample.
use super::{Out, Record, finite, number, points, records, text_of};
use crate::legacy_json::{self, Node, Number, Value};
use crate::python_number::PythonNumber;

/// One summary file as the effects read it: its text, or why not.
pub enum PruneRead {
    Text(String),
    /// `(str(error), class name)` of an `OSError` or `InputError`.
    Failed(String, &'static str),
}

/// `prune-runs.jsonl`: genuinely new, readable, or present but unreadable
/// within bounds. An unavailable ledger is never an empty committed set.
pub enum Ledger {
    Missing,
    Unavailable,
    Read {
        records: Vec<Record>,
        malformed: usize,
    },
}

impl Ledger {
    /// The ledger's committed records from its text.
    pub fn from_text(text: &str) -> Self {
        let (records, malformed) = records(text);
        Self::Read { records, malformed }
    }
    pub fn available(&self) -> bool {
        !matches!(self, Self::Unavailable)
    }
    pub fn malformed(&self) -> usize {
        match self {
            Self::Read { malformed, .. } => *malformed,
            _ => 0,
        }
    }
    /// The committed records, then the newly joined ones.
    pub fn into_runs(self, joined: &[Out]) -> Vec<Record> {
        let mut runs = match self {
            Self::Read { records, .. } => records,
            _ => Vec::new(),
        };
        runs.extend(joined.iter().filter_map(reread));
        runs
    }
    fn committed(&self) -> Vec<Vec<u32>> {
        match self {
            Self::Read { records, .. } => records
                .iter()
                .filter_map(|record| text_of(record.get("run_id")).map(<[u32]>::to_vec))
                .collect(),
            _ => Vec::new(),
        }
    }
}

/// A record written this run, read back exactly as a later run would.
fn reread(value: &Out) -> Option<Record> {
    let text = super::dump(value)?;
    legacy_json::decode_text(&text).ok().map(Record)
}

/// The join of one sample: records first committed now (without
/// `committed_t`), bounded errors and the backlog left for later samples.
#[derive(Debug, Default)]
pub struct PruneJoin {
    pub records: Vec<Out>,
    pub errors: Vec<Out>,
    pub backlog: i64,
}

/// `RUN_ID_RE.match`: `^[A-Za-z0-9._-]{1,128}$`, where `$` also matches
/// before one final newline.
fn run_id(points: &[u32]) -> bool {
    let body = points.strip_suffix(&[u32::from('\n')]).unwrap_or(points);
    (1..=128).contains(&body.len())
        && body.iter().all(|point| {
            char::from_u32(*point)
                .is_some_and(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        })
}

fn integral(value: Option<&Value>) -> Option<Out> {
    let number = finite(value)?;
    match number {
        PythonNumber::Int(value) if value >= 0 => Some(Out::int(value)),
        PythonNumber::Float(value) if value >= 0.0 && value.fract() == 0.0 => {
            Some(Out::Int(float_digits(value)))
        }
        _ => None,
    }
}

/// `int(x)` of an integral, non-negative float, exactly.
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn float_digits(value: f64) -> String {
    if value < 1.0e18 {
        return (value as u64).to_string();
    }
    let bits = value.to_bits();
    let exponent = i32::try_from((bits >> 52) & 0x7ff).unwrap_or(0) - 1075;
    let mantissa = (bits & ((1u64 << 52) - 1)) | (1u64 << 52);
    // mantissa * 2^exponent in base-1e9 limbs, least significant first.
    let mut limbs = vec![
        u64::from((mantissa % 1_000_000_000) as u32),
        mantissa / 1_000_000_000,
    ];
    for _ in 0..exponent {
        let mut carry = 0;
        for limb in &mut limbs {
            let doubled = *limb * 2 + carry;
            *limb = doubled % 1_000_000_000;
            carry = doubled / 1_000_000_000;
        }
        if carry > 0 {
            limbs.push(carry);
        }
    }
    while limbs.len() > 1 && limbs.last() == Some(&0) {
        limbs.pop();
    }
    let mut text = limbs.last().map_or_else(String::new, u64::to_string);
    for limb in limbs.iter().rev().skip(1) {
        text.push_str(&format!("{limb:09}"));
    }
    text
}

fn get<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    super::field(value, key)
}

/// `validate_summary(s, name)`: the prune-runs record without `committed_t`.
fn validate(summary: &Value, name: &[u32]) -> Result<Out, &'static str> {
    let Node::Object(_) = &summary.0 else {
        return Err("not an object");
    };
    let id = match get(summary, "run_id") {
        Some(Value(Node::Null)) | None => name.to_vec(),
        Some(Value(Node::String(text))) => text.0.clone(),
        Some(_) => return Err("bad run_id"),
    };
    if !run_id(&id) {
        return Err("bad run_id");
    }
    let mode = match text_of(get(summary, "mode")) {
        Some(mode) if mode == points("dry").as_slice() => "dry",
        Some(mode) if mode == points("live").as_slice() => "live",
        _ => return Err("bad mode"),
    };
    let exit = match get(summary, "exit") {
        Some(Value(Node::Number(Number::Integer(digits)))) => digits.clone(),
        _ => return Err("bad exit"),
    };
    let bytes = match get(summary, "deleted_or_would_bytes") {
        None => Out::int(0),
        value => integral(value).ok_or("bad byte count")?,
    };
    let decisions = match get(summary, "by_decision") {
        None => Out::Map(Default::default()),
        Some(Value(Node::Object(map))) if map.len() <= 64 => Out::Map(
            map.iter()
                .map(|(key, value)| {
                    (key.0.len() <= 64)
                        .then(|| integral(Some(value)))
                        .flatten()
                        .map(|count| (key.0.clone(), count))
                })
                .collect::<Option<_>>()
                .ok_or("bad by_decision")?,
        ),
        Some(_) => return Err("bad by_decision"),
    };
    let passes = match get(summary, "passes") {
        None => Out::List(Vec::new()),
        Some(Value(Node::Array(values))) if values.len() <= 8 => Out::List(
            values
                .iter()
                .map(|value| match &value.0 {
                    Node::String(text) if text.0.len() <= 32 => Some(Out::Text(text.0.clone())),
                    _ => None,
                })
                .collect::<Option<_>>()
                .ok_or("bad passes")?,
        ),
        Some(_) => return Err("bad passes"),
    };
    let ceiling = match get(summary, "ceiling_hit") {
        None => false,
        Some(Value(Node::Bool(flag))) => *flag,
        Some(_) => return Err("bad ceiling_hit"),
    };
    let status = match number(get(summary, "exit")) {
        Some(PythonNumber::Int(0)) => "ok",
        Some(PythonNumber::Int(4)) => "partial",
        _ => "failed",
    };
    let (would, deleted) = if mode == "dry" {
        (bytes, Out::int(0))
    } else {
        (Out::int(0), bytes)
    };
    Ok(Out::Map(
        [
            ("run_id", Out::Text(id)),
            ("mode", Out::text(mode)),
            ("status", Out::text(status)),
            ("exit", Out::Int(exit)),
            ("passes", passes),
            ("would_delete_bytes", would),
            ("deleted_bytes", deleted),
            ("by_decision", decisions),
            ("ceiling_hit", Out::Bool(ceiling)),
        ]
        .into_iter()
        .map(|(key, value)| (points(key), value))
        .collect(),
    ))
}

fn record_id(record: &Out) -> Option<&[u32]> {
    match record {
        Out::Map(map) => match map.get(&points("run_id")) {
            Some(Out::Text(id)) => Some(id),
            _ => None,
        },
        _ => None,
    }
}

const SUFFIX: &str = ".summary.json";

/// `new_prune_runs(cfg, committed)` over the sorted summary names (`None`
/// without a prune log directory) and their reads.
pub fn join_prune_runs(
    names: Option<Vec<Vec<u32>>>,
    mut read: impl FnMut(&[u32]) -> PruneRead,
    ledger: &Ledger,
    limit: i64,
) -> PruneJoin {
    let mut join = PruneJoin::default();
    let committed = ledger.committed();
    let suffix = points(SUFFIX);
    for name in names.unwrap_or_default() {
        let Some(stem) = name.strip_suffix(suffix.as_slice()) else {
            continue;
        };
        if committed.iter().any(|id| id.as_slice() == stem) {
            continue;
        }
        match parse(read(&name), stem) {
            Ok(record) => join.admit(record, &committed, limit),
            Err((reason, class)) if join.errors.len() < 20 => join.error(&name, &reason, class),
            Err(_) => {}
        }
    }
    join
}

/// One summary read, decoded and validated, or `(str(error), class name)`.
fn parse(read: PruneRead, stem: &[u32]) -> Result<Out, (String, &'static str)> {
    let text = match read {
        PruneRead::Failed(reason, class) => return Err((reason, class)),
        PruneRead::Text(text) => text,
    };
    let summary = legacy_json::decode_text(&text)
        .map_err(|_| ("invalid JSON".to_owned(), "JSONDecodeError"))?;
    validate(&summary, stem).map_err(|reason| (reason.to_owned(), "InputError"))
}

impl PruneJoin {
    /// Keep a new run once; beyond the per-sample bound it is backlog.
    fn admit(&mut self, record: Out, committed: &[Vec<u32>], limit: i64) {
        let id = record_id(&record).unwrap_or_default();
        let repeated = committed.iter().any(|known| known.as_slice() == id)
            || self
                .records
                .iter()
                .any(|other| record_id(other) == Some(id));
        if repeated {
            return;
        }
        if i64::try_from(self.records.len()).unwrap_or(i64::MAX) >= limit {
            self.backlog += 1;
        } else {
            self.records.push(record);
        }
    }

    /// `{"file": n[:200], "reason": str(e)[:120] or class name}`.
    fn error(&mut self, name: &[u32], reason: &str, class: &str) {
        let reason = reason.chars().take(120).collect::<String>();
        let reason = if reason.is_empty() {
            class.to_owned()
        } else {
            reason
        };
        self.errors.push(Out::Map(
            [
                (
                    points("file"),
                    Out::Text(name.iter().copied().take(200).collect()),
                ),
                (points("reason"), Out::text(&reason)),
            ]
            .into_iter()
            .collect(),
        ));
    }
}
