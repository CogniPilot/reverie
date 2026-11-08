//! `cleanup/receipts.py`: path-free, unauthenticated receipt records from
//! reverie-prune run summaries and A1 exception reports. The caller reads and
//! writes files; this module reproduces the records, identities, retention and
//! summary line of the Python adapter byte for byte.
#[cfg(test)]
mod tests;
mod text;

use crate::legacy_json::{self, Node, Number, Text, Value, truthy};
use crate::worker_config::{compact_data, encode_data};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use text::{digits_t_z, is_id, is_sha, is_utc, python_blank, utc};
pub use text::{python_float, python_int, universal_lines};

const VERSION: u64 = 1;
const UNAVAILABLE: &str = "UNAVAILABLE";
const LEVEL: &str = "PRODUCER_OUTPUT_UNAUTHENTICATED";
const MAX_INT: u64 = (1 << 53) - 1;
const DECISIONS: [&str; 9] = [
    "WOULD_DELETE",
    "DELETED",
    "SKIP",
    "PARTIAL",
    "REPORT",
    "NOT_REGISTERED",
    "WIDEN_REFUSED",
    "STOPPED_CEILING",
    "LEASE_LONG_HELD",
];
const A1_COUNTS: [&str; 9] = [
    "runs",
    "runs_with_problems",
    "partial_rows",
    "unknown_rows",
    "safety_refused_rows",
    "deleted_rows",
    "ceiling_hit_runs",
    "in_use_after_would_delete_paths",
    "undated_logs_outside_window",
];
const A1_LISTS: [&str; 7] = [
    "leases_held",
    "leases_long_held",
    "not_registered",
    "retired_by_size",
    "partial",
    "widen_refused",
    "refused_for_safety",
];
const PASSES: [&str; 4] = ["high-water", "checkouts", "retired", "leases"];

/// A refusal code (`Refused.code`): the input is counted and not written.
pub type Code = &'static str;

/// An uncaught Python exception, by class name: the command exits 1 with
/// nothing on stdout.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Crash(pub &'static str);

/// `file_ref`: the input bytes' sha256 hex and length.
pub struct Reference {
    pub sha256: String,
    pub bytes: usize,
}

impl Reference {
    pub fn of(data: &[u8]) -> Self {
        Self {
            sha256: hex(&Sha256::digest(data)),
            bytes: data.len(),
        }
    }
}

/// One finished record: its `receipt_id` and canonical line.
#[derive(Debug, Eq, PartialEq)]
pub struct Receipt {
    pub id: String,
    pub line: String,
}

/// `load_context(path)`: the operator's trusted producer context.
pub struct Context {
    producer_source: Text,
    config: Text,
    actor: Text,
    host: Text,
    admissions: BTreeMap<Text, (Text, Text)>,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn text_of(value: &str) -> Text {
    Text(value.chars().map(u32::from).collect())
}

fn string(value: &str) -> Value {
    Value(Node::String(text_of(value)))
}

fn integer(value: impl ToString) -> Value {
    Value(Node::Number(Number::Integer(value.to_string())))
}

fn object<'a>(entries: impl IntoIterator<Item = (&'a str, Value)>) -> Value {
    Value(Node::Object(fields(entries)))
}

fn get<'a>(values: &'a BTreeMap<Text, Value>, key: &str) -> Option<&'a Value> {
    values.get(&text_of(key))
}

fn is_text(value: Option<&Value>, expected: &str) -> bool {
    matches!(value, Some(Value(Node::String(text))) if text.equals_ascii(expected))
}

/// `value or {}` followed by `.get`: a truthy non-object is an AttributeError.
fn mapping(value: Option<&Value>) -> Result<Option<&BTreeMap<Text, Value>>, Crash> {
    match value {
        _ if !truthy(value) => Ok(None),
        Some(Value(Node::Object(values))) => Ok(Some(values)),
        _ => Err(Crash("AttributeError")),
    }
}

/// What iterating `value or []` yields: array items, object keys or the
/// characters of a string. Numbers and booleans are a TypeError.
enum Item<'a> {
    Value(&'a Value),
    Text(Text),
}

fn items(value: Option<&Value>) -> Result<Vec<Item<'_>>, Crash> {
    match value {
        _ if !truthy(value) => Ok(Vec::new()),
        Some(Value(Node::Array(values))) => Ok(values.iter().map(Item::Value).collect()),
        Some(Value(Node::Object(values))) => Ok(values.keys().cloned().map(Item::Text).collect()),
        Some(Value(Node::String(text))) => {
            Ok(text.0.iter().map(|c| Item::Text(Text(vec![*c]))).collect())
        }
        _ => Err(Crash("TypeError")),
    }
}

impl Item<'_> {
    fn text(&self) -> Option<&Text> {
        match self {
            Self::Value(Value(Node::String(text))) | Self::Text(text) => Some(text),
            Self::Value(_) => None,
        }
    }
    /// `row.get(...)` needs an object: anything else is an AttributeError.
    fn object(&self) -> Result<&BTreeMap<Text, Value>, Crash> {
        match self {
            Self::Value(Value(Node::Object(values))) => Ok(values),
            _ => Err(Crash("AttributeError")),
        }
    }
}

/// `bounded_int(value)`: an integer (not a boolean) in 0..=2**53-1. A missing
/// key is the `.get(key, 0)` default.
fn bounded(value: Option<&Value>) -> Result<u64, Code> {
    let refused = "FIELD_OUT_OF_BOUNDS";
    match value {
        None => Ok(0),
        Some(Value(Node::Number(Number::Integer(digits)))) => digits
            .parse::<u64>()
            .ok()
            .filter(|value| *value <= MAX_INT)
            .ok_or(refused),
        Some(_) => Err(refused),
    }
}

/// `ident(value)`: a short opaque identifier, or UNAVAILABLE for None.
fn ident(value: Option<&Value>) -> Result<Text, Code> {
    match value {
        None | Some(Value(Node::Null)) => Ok(text_of(UNAVAILABLE)),
        Some(Value(Node::String(text))) if is_id(&text.0) => Ok(text.clone()),
        Some(_) => Err("PRIVATE_OR_INVALID_STRING"),
    }
}

impl Context {
    fn unavailable() -> Self {
        Self {
            producer_source: text_of(UNAVAILABLE),
            config: text_of(UNAVAILABLE),
            actor: text_of(UNAVAILABLE),
            host: text_of(UNAVAILABLE),
            admissions: BTreeMap::new(),
        }
    }

    /// `load_context(path)`: `None` when no path was given. The second value
    /// lists the rejected context fields, in reading order.
    pub fn load(text: Option<&str>) -> Result<(Self, Vec<&'static str>), Crash> {
        let mut context = Self::unavailable();
        let mut rejected = Vec::new();
        let Some(text) = text else {
            return Ok((context, rejected));
        };
        let raw = legacy_json::decode_text(text).map_err(|_| Crash("JSONDecodeError"))?;
        let Value(Node::Object(raw)) = &raw else {
            return Err(Crash("AttributeError"));
        };
        for (key, slot) in [
            ("producer_source_sha256", &mut context.producer_source),
            ("config_sha256", &mut context.config),
        ] {
            match get(raw, key) {
                Some(Value(Node::String(value))) if is_sha(&value.0) => *slot = value.clone(),
                None | Some(Value(Node::Null)) => {}
                Some(_) => rejected.push(key),
            }
        }
        for (key, slot) in [
            ("actor_ref", &mut context.actor),
            ("host_key", &mut context.host),
        ] {
            match ident(get(raw, key)) {
                Ok(value) => *slot = value,
                Err(_) => rejected.push(key),
            }
        }
        let Some(admissions) = mapping(get(raw, "admissions"))? else {
            return Ok((context, rejected));
        };
        for (run, binding) in admissions {
            let bound = match binding {
                Value(Node::Object(binding)) => ident(get(binding, "idempotency_key"))
                    .and_then(|key| Ok((key, ident(get(binding, "lease_id"))?))),
                _ => Err("AttributeError"),
            };
            match (bound, is_id(&run.0)) {
                (Ok(bound), true) => {
                    context.admissions.insert(run.clone(), bound);
                }
                _ => rejected.push("admissions"),
            }
        }
        Ok((context, rejected))
    }

    fn base(
        &self,
        kind: &str,
        run: Text,
        reference: &Reference,
        utc: Value,
    ) -> BTreeMap<Text, Value> {
        let evidence = kind.split('_').next().unwrap_or_default().to_lowercase();
        fields([
            ("version", integer(VERSION)),
            ("event_kind", string(kind)),
            ("run_id", Value(Node::String(run))),
            ("utc", utc),
            ("evidence_level", string(LEVEL)),
            (
                "producer",
                object([
                    (
                        "source_sha256",
                        Value(Node::String(self.producer_source.clone())),
                    ),
                    ("config_sha256", Value(Node::String(self.config.clone()))),
                ]),
            ),
            ("actor_ref", Value(Node::String(self.actor.clone()))),
            ("host_key", Value(Node::String(self.host.clone()))),
            ("subject_sha256", string(&reference.sha256)),
            (
                "evidence_ref",
                object([
                    ("kind", string(&evidence)),
                    ("sha256", string(&reference.sha256)),
                    ("bytes", integer(reference.bytes)),
                ]),
            ),
        ])
    }
}

fn unavailable_effect() -> Value {
    object([
        ("idempotency_key", string(UNAVAILABLE)),
        ("lease_id", string(UNAVAILABLE)),
    ])
}

/// `finish(record, keys)`: receipt_id is the sha256 of the default
/// `json.dumps` of the identity keys; the line is the compact sorted dump.
fn finish(mut record: BTreeMap<Text, Value>, keys: &[&str]) -> Receipt {
    let identity = Value(Node::Object(
        keys.iter()
            .filter_map(|key| Some((text_of(key), get(&record, key)?.deep_clone())))
            .collect(),
    ));
    let id = hex(&Sha256::digest(encode_data(&identity)));
    record.insert(text_of("receipt_id"), string(&id));
    let line = String::from_utf8(compact_data(&Value(Node::Object(record)))).unwrap_or_default();
    Receipt { id, line }
}

/// `run_time(run_id)`: the start time of reverie-prune's default run id.
fn run_time(run: &Text) -> Value {
    let head = run
        .0
        .iter()
        .take(16)
        .map(|c| char::from_u32(*c))
        .collect::<Option<String>>();
    let shape = |text: &str| {
        text.len() == 16
            && text.char_indices().all(|(at, c)| match at {
                8 => c == 'T',
                15 => c == 'Z',
                _ => c.is_ascii_digit(),
            })
    };
    match head {
        Some(head) if shape(&head) => string(&format!(
            "{}-{}-{}T{}:{}:{}Z",
            &head[0..4],
            &head[4..6],
            &head[6..8],
            &head[9..11],
            &head[11..13],
            &head[13..15]
        )),
        _ => string(UNAVAILABLE),
    }
}

/// `EXIT_CODES.get(exit)` for an `int` (a boolean is one), else UNKNOWN.
fn exit_class(exit: Option<&Value>) -> (&'static str, &'static str, Value) {
    let numeric = match exit {
        Some(Value(Node::Bool(value))) => Some(if *value { "1" } else { "0" }),
        Some(Value(Node::Number(Number::Integer(digits)))) => Some(digits.as_str()),
        _ => None,
    };
    let Some(numeric) = numeric else {
        return ("UNKNOWN", "RUN_EXIT_UNKNOWN", string(UNAVAILABLE));
    };
    let source = match exit {
        Some(Value(Node::Bool(value))) => Value(Node::Bool(*value)),
        _ => integer(numeric),
    };
    let (class, code) = match numeric {
        "0" => ("OK", "RUN_OK"),
        "2" => ("REFUSED", "RUN_PRECONDITION_REFUSED"),
        "3" => ("REFUSED", "RUN_LIVE_NOT_ENABLED"),
        "4" => ("PARTIAL", "RUN_PARTIAL"),
        "5" => ("REFUSED", "RUN_BUSY"),
        _ => ("FAILED", "RUN_FAILED"),
    };
    (class, code, source)
}

/// The `by_decision` counts: known decisions with bounded integers.
fn decisions(summary: &BTreeMap<Text, Value>) -> Result<Result<BTreeMap<Text, u64>, Code>, Crash> {
    let mut counts = BTreeMap::new();
    if let Some(decisions) = mapping(get(summary, "by_decision"))? {
        for (decision, count) in decisions {
            if !DECISIONS.iter().any(|name| decision.equals_ascii(name)) {
                return Ok(Err("FIELD_OUT_OF_BOUNDS"));
            }
            match bounded(Some(count)) {
                Ok(count) => counts.insert(decision.clone(), count),
                Err(code) => return Ok(Err(code)),
            };
        }
    }
    Ok(Ok(counts))
}

/// `from_summary(path, ctx, max_bytes)` after `file_ref`: `name` is the
/// input's file name. `Err` is an uncaught exception.
pub fn from_summary(
    name: &[u32],
    data: &[u8],
    reference: &Reference,
    context: &Context,
) -> Result<Result<Receipt, Code>, Crash> {
    let decoded = legacy_json::decode_loads_bytes(data);
    let Ok(Value(Node::Object(summary))) = &decoded else {
        return Ok(Err("INPUT_UNREADABLE"));
    };
    let run = match get(summary, "run_id") {
        None | Some(Value(Node::Null)) => return Ok(Err("MISSING_IDENTITY")),
        value => match ident(value) {
            Ok(run) => run,
            Err(code) => return Ok(Err(code)),
        },
    };
    let mut expected = run.0.clone();
    expected.extend(".summary.json".chars().map(u32::from));
    if name != expected.as_slice() {
        return Ok(Err("IDENTITY_MISMATCH"));
    }
    let mode = get(summary, "mode");
    let dry = is_text(mode, "dry");
    if !dry && !is_text(mode, "live") {
        return Ok(Err("FIELD_OUT_OF_BOUNDS"));
    }
    let (class, code, exit) = exit_class(get(summary, "exit"));
    let counts = match decisions(summary)? {
        Ok(counts) => counts,
        Err(code) => return Ok(Err(code)),
    };
    let total = match bounded(get(summary, "deleted_or_would_bytes")) {
        Ok(total) => total,
        Err(code) => return Ok(Err(code)),
    };
    let df = match drives(summary)? {
        Ok(df) => df,
        Err(code) => return Ok(Err(code)),
    };
    let admission = context.admissions.get(&run);
    let bound = !dry && admission.is_some();
    let kind = if bound {
        "PRUNE_TERMINAL"
    } else {
        "PRUNE_OBSERVATION"
    };
    let mut record = context.base(kind, run.clone(), reference, run_time(&run));
    let effect = match admission.filter(|_| bound) {
        Some((key, lease)) => Value(Node::Object(BTreeMap::from([
            (text_of("idempotency_key"), Value(Node::String(key.clone()))),
            (text_of("lease_id"), Value(Node::String(lease.clone()))),
        ]))),
        None => unavailable_effect(),
    };
    let passes = items(get(summary, "passes"))?
        .iter()
        .filter_map(Item::text)
        .filter(|pass| PASSES.iter().any(|name| pass.equals_ascii(name)))
        .map(|pass| Value(Node::String(pass.clone())))
        .collect();
    let count = |name: &str| counts.get(&text_of(name)).copied().unwrap_or(0);
    let codes = if dry && count("WOULD_DELETE") > 0 {
        vec![string("WOULD_DELETE")]
    } else if !dry && count("DELETED") > 0 {
        vec![string("REPORTED_DELETED")]
    } else {
        Vec::new()
    };
    let by_decision = counts
        .iter()
        .map(|(decision, count)| (decision.clone(), integer(count)))
        .collect();
    let update = fields([
        ("effect", effect),
        ("result_class", string(class)),
        ("code", string(code)),
        (
            "source",
            object([
                ("mode", string(if dry { "dry" } else { "live" })),
                ("exit", exit),
                ("passes", Value(Node::Array(passes))),
                ("by_decision", Value(Node::Object(by_decision))),
                (
                    "ceiling_hit",
                    Value(Node::Bool(truthy(get(summary, "ceiling_hit")))),
                ),
                ("df", Value(Node::Array(df))),
            ]),
        ),
        (
            "metrics",
            object([
                ("would_delete_bytes", integer(if dry { total } else { 0 })),
                (
                    "reported_deleted_bytes",
                    integer(if dry { 0 } else { total }),
                ),
            ]),
        ),
        ("codes", Value(Node::Array(codes))),
    ]);
    record.extend(update);
    Ok(Ok(finish(record, &["event_kind", "run_id"])))
}

/// The `df_before`/`df_after` rows by position, without their paths.
fn drives(summary: &BTreeMap<Text, Value>) -> Result<Result<Vec<Value>, Code>, Crash> {
    let mut rows = Vec::new();
    for row in items(get(summary, "df_before"))? {
        let row = row.object()?;
        let total = match bounded(get(row, "total")) {
            Ok(total) => total,
            Err(code) => return Ok(Err(code)),
        };
        let free = match bounded(get(row, "free")) {
            Ok(free) => free,
            Err(code) => return Ok(Err(code)),
        };
        rows.push(BTreeMap::from([
            (text_of("total"), integer(total)),
            (text_of("free_before"), integer(free)),
        ]));
    }
    for (at, row) in items(get(summary, "df_after"))?.iter().enumerate() {
        let Some(slot) = rows.get_mut(at) else {
            continue;
        };
        match bounded(get(row.object()?, "free")) {
            Ok(free) => slot.insert(text_of("free_after"), integer(free)),
            Err(code) => return Ok(Err(code)),
        };
    }
    Ok(Ok(rows
        .into_iter()
        .map(|row| Value(Node::Object(row)))
        .collect()))
}

/// Python `str(value)` reduced to its digits, `T` and `Z` (`re.sub(r"[^0-9TZ]", "", ...)`).
fn bound_text(value: Option<&Value>, fallback: &str) -> Vec<u32> {
    match value {
        Some(value) if truthy(Some(value)) => digits_t_z(value),
        _ => digits_t_z(&string(fallback)),
    }
}

/// `from_a1(path, ctx, max_bytes)` after `file_ref`.
pub fn from_a1(
    data: &[u8],
    reference: &Reference,
    context: &Context,
) -> Result<Result<Receipt, Code>, Crash> {
    let decoded = legacy_json::decode_loads_bytes(data);
    let report = match &decoded {
        Ok(Value(Node::Object(report))) => report,
        Ok(_) => return Ok(Err("MISSING_IDENTITY")),
        Err(_) => return Ok(Err("INPUT_UNREADABLE")),
    };
    if !is_text(get(report, "tool"), "prune_exceptions") {
        return Ok(Err("MISSING_IDENTITY"));
    }
    let gate_value = get(report, "gate");
    let window = mapping(get(report, "window"))?;
    let since = window.and_then(|window| get(window, "since"));
    let until = window
        .and_then(|window| get(window, "until"))
        .filter(|value| truthy(Some(value)))
        .or_else(|| get(report, "generated_utc"));
    let mut run = "a1-".chars().map(u32::from).collect::<Vec<_>>();
    run.extend(bound_text(since, "start"));
    run.push(u32::from('-'));
    run.extend(bound_text(until, "now"));
    run.truncate(64);
    let generated = match get(report, "generated_utc") {
        Some(Value(Node::String(text))) if is_utc(&text.0) => Value(Node::String(text.clone())),
        _ => string(UNAVAILABLE),
    };
    let mut record = context.base("A1_EXCEPTIONS", Text(run), reference, generated);
    let gate = mapping(gate_value)?;
    let mut counts = BTreeMap::new();
    for name in A1_COUNTS {
        match bounded(gate.and_then(|gate| get(gate, name))) {
            Ok(count) => counts.insert(name.to_owned(), count),
            Err(code) => return Ok(Err(code)),
        };
    }
    for name in A1_LISTS {
        let length = match get(report, name) {
            value if !truthy(value) => 0,
            Some(Value(Node::Array(values))) => values.len(),
            Some(Value(Node::Object(values))) => values.len(),
            Some(Value(Node::String(text))) => text.0.len(),
            _ => return Err(Crash("TypeError")),
        };
        counts.insert(format!("{name}_count"), length as u64);
    }
    let problems = match get(report, "run_problems") {
        value if !truthy(value) => Vec::new(),
        Some(Value(Node::Array(values))) => values
            .iter()
            .take(20)
            .map(|item| match item {
                Value(Node::Object(item)) => {
                    ident(get(item, "run_id")).unwrap_or_else(|_| text_of(UNAVAILABLE))
                }
                _ => text_of(UNAVAILABLE),
            })
            .collect(),
        Some(Value(Node::String(text))) => vec![text_of(UNAVAILABLE); text.0.len().min(20)],
        _ => return Err(Crash("TypeError")),
    };
    let present = counts["runs_with_problems"] > 0
        || A1_LISTS
            .iter()
            .any(|name| counts[&format!("{name}_count")] > 0);
    let metrics = counts
        .iter()
        .map(|(name, count)| (text_of(name), integer(count)))
        .collect();
    let update = fields([
        ("effect", unavailable_effect()),
        ("result_class", string("OBSERVATION")),
        (
            "code",
            string(if present {
                "EXCEPTIONS_PRESENT"
            } else {
                "NO_EXCEPTIONS"
            }),
        ),
        ("metrics", Value(Node::Object(metrics))),
        (
            "problem_run_ids",
            Value(Node::Array(
                problems
                    .into_iter()
                    .map(|run| Value(Node::String(run)))
                    .collect(),
            )),
        ),
        ("codes", Value(Node::Array(Vec::new()))),
    ]);
    record.extend(update);
    Ok(Ok(finish(
        record,
        &["event_kind", "run_id", "subject_sha256"],
    )))
}

/// `existing(out_path)` on the file's text: receipt_id to line.
pub fn existing(text: &str) -> Result<BTreeMap<String, String>, Crash> {
    let mut ids = BTreeMap::new();
    for line in universal_lines(text) {
        if python_blank(&line) {
            continue;
        }
        let decoded = legacy_json::decode_text(&line).map_err(|_| Crash("JSONDecodeError"))?;
        let Value(Node::Object(record)) = &decoded else {
            return Err(Crash("TypeError"));
        };
        match get(record, "receipt_id") {
            None => return Err(Crash("KeyError")),
            Some(Value(Node::Array(_) | Node::Object(_))) => return Err(Crash("TypeError")),
            Some(Value(Node::String(id))) => {
                if let Some(id) =
                    id.0.iter()
                        .map(|c| char::from_u32(*c))
                        .collect::<Option<String>>()
                {
                    ids.insert(id, line.trim_end_matches('\n').to_owned());
                }
            }
            // A non-string identifier can never equal a new receipt_id.
            Some(_) => {}
        }
    }
    Ok(ids)
}

/// Why retention stopped: an uncaught exception, or an OSError that leaves
/// the output UNKNOWN.
#[derive(Debug, Eq, PartialEq)]
pub enum RetainError {
    Crash(Crash),
    Os,
}

impl From<Crash> for RetainError {
    fn from(crash: Crash) -> Self {
        Self::Crash(crash)
    }
}

/// The retention limits, as given on the command line.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub entries: i64,
    pub bytes: i64,
    pub age_days: f64,
}

/// `retain(...)` on the output's text: the number of dropped records and, if
/// any, the replacement text (kept lines plus the RETENTION_DROP record).
pub fn retain(
    text: &str,
    limits: Limits,
    now: f64,
) -> Result<(usize, Option<String>), RetainError> {
    let all = universal_lines(text);
    let lines = all
        .iter()
        .filter(|line| !python_blank(line))
        .map(|line| line.trim_end_matches('\n'))
        .collect::<Vec<_>>();
    let mut keep = lines.clone();
    if limits.age_days != 0.0 {
        let cutoff = utc(now - limits.age_days * 86400.0)?;
        let mut dated = Vec::new();
        for line in keep {
            let decoded = legacy_json::decode_text(line).map_err(|_| Crash("JSONDecodeError"))?;
            let Value(Node::Object(record)) = &decoded else {
                return Err(Crash("AttributeError").into());
            };
            let stamp = get(record, "utc");
            if stamp.is_none() || is_text(stamp, UNAVAILABLE) {
                dated.push(line);
                continue;
            }
            let Some(Value(Node::String(stamp))) = stamp else {
                return Err(Crash("TypeError").into());
            };
            if stamp
                .0
                .iter()
                .copied()
                .cmp(cutoff.chars().map(u32::from))
                .is_ge()
            {
                dated.push(line);
            }
        }
        keep = dated;
    }
    let length = keep.len() as i128;
    if limits.entries != 0 && length > i128::from(limits.entries) {
        // `keep[-max_entries:]`, including a negative limit.
        let start = if limits.entries > 0 {
            length - i128::from(limits.entries)
        } else {
            (-i128::from(limits.entries)).min(length)
        };
        keep.drain(..usize::try_from(start).unwrap_or(0));
    }
    let size = |keep: &[&str]| {
        keep.iter()
            .map(|line| line.chars().count() as i128 + 1)
            .sum::<i128>()
    };
    while limits.bytes != 0 && !keep.is_empty() && size(&keep) > i128::from(limits.bytes) {
        keep.remove(0);
    }
    let dropped = lines.len() - keep.len();
    if dropped == 0 {
        return Ok((0, None));
    }
    let stamp = utc(now)?;
    let note = fields([
        ("version", integer(VERSION)),
        ("event_kind", string("RETENTION_DROP")),
        (
            "run_id",
            string(&format!("retention-{}", stamp.replace(['-', ':'], ""))),
        ),
        (
            "subject_sha256",
            string(&hex(&Sha256::digest(lines[..dropped].join("\n")))),
        ),
        ("utc", string(&stamp)),
        ("evidence_level", string(LEVEL)),
        ("result_class", string("OBSERVATION")),
        ("code", string("RETENTION_DROPPED")),
        ("metrics", object([("dropped", integer(dropped))])),
    ]);
    let note = finish(note, &["event_kind", "run_id"]);
    let mut replacement = keep
        .iter()
        .map(|line| format!("{line}\n"))
        .collect::<String>();
    replacement.push_str(&note.line);
    replacement.push('\n');
    Ok((dropped, Some(replacement)))
}

/// The printed summary: `json.dumps({...}, sort_keys=True)`.
pub fn summary(
    committed: bool,
    written: usize,
    duplicates: usize,
    refusals: &[Code],
    rejected: &[&str],
    dropped: usize,
) -> String {
    let mut refused = BTreeMap::<Text, u64>::new();
    for code in refusals {
        *refused.entry(text_of(code)).or_default() += 1;
    }
    let mut fields = rejected
        .iter()
        .map(|field| text_of(field))
        .collect::<Vec<_>>();
    fields.sort();
    fields.dedup();
    let value = object([
        (
            "status",
            string(if committed { "COMMITTED" } else { "UNKNOWN" }),
        ),
        ("written", integer(if committed { written } else { 0 })),
        ("duplicates", integer(duplicates)),
        (
            "refused",
            Value(Node::Object(
                refused
                    .into_iter()
                    .map(|(code, n)| (code, integer(n)))
                    .collect(),
            )),
        ),
        (
            "context_fields_rejected",
            Value(Node::Array(
                fields
                    .into_iter()
                    .map(|field| Value(Node::String(field)))
                    .collect(),
            )),
        ),
        ("retention_dropped", integer(dropped)),
    ]);
    String::from_utf8(encode_data(&value)).unwrap_or_default()
}

fn fields<'a>(entries: impl IntoIterator<Item = (&'a str, Value)>) -> BTreeMap<Text, Value> {
    entries
        .into_iter()
        .map(|(key, value)| (text_of(key), value))
        .collect()
}
