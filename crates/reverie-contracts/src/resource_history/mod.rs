//! The path-free projection of `cleanup/collector_history.py` over explicitly
//! configured USER observations, as data: the host supplies custody-checked
//! bytes through `HistorySource` and owns every file, clock and deadline
//! effect. The output is Python's `json.dumps(..., allow_nan=False,
//! separators=(',', ':'))` of the same object, with identical number types.
mod points;
mod scan;
#[cfg(test)]
mod tests;

use crate::legacy_json::{self, Node, Number, Text, Value};

pub(crate) const MAX_BYTES: usize = 32 << 20;
pub(crate) const MAX_ROWS: i128 = 100_000;
pub(crate) const MAX_POINTS: i128 = 1024;
/// Per committed or raw file read (`private_bytes(file, 8 << 20)`).
pub const FILE_LIMIT: usize = 8 << 20;
/// The user configuration read bound (`MAX_CONFIG`).
pub const CONFIG_LIMIT: usize = 16384;
/// The freshness tail (`freshness_tail`).
pub const TAIL_BYTES: u64 = 262_144;
/// The output bound.
pub const OUTPUT_LIMIT: usize = 2 << 20;

/// A refusal; the command reports only `Resource history unavailable`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct HistoryRefused(pub &'static str);

/// The validated `collector_user.configuration` fields the reader uses.
/// Path texts are Python `str` codepoints; the host checks their custody.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ObservationConfig {
    pub state_directory: Vec<u32>,
    pub interval_seconds: i64,
    pub retention_days: i64,
    pub rollup_retention_days: i64,
    pub drives: Drives,
    pub gpu_executable: Option<Vec<u32>>,
}

/// One query (`query(path, start, end, resolution, gpu, now)`).
#[derive(Clone, Debug)]
pub struct HistoryRequest {
    pub start: i64,
    pub end: i64,
    pub resolution: String,
    pub gpu: Option<String>,
    pub now: i64,
}

/// `freshness_tail`: the private tail bytes after any partial first record,
/// the bytes charged, and whether the whole file was read.
pub struct Tail {
    pub data: Vec<u8>,
    pub charged: usize,
    pub complete: bool,
}

/// The custody-checked state directory as the projection reads it.
pub trait HistorySource {
    /// Every entry name, sorted (`sorted(root.iterdir())`).
    fn entries(&mut self) -> Result<Vec<String>, HistoryRefused>;
    /// `private_bytes(root / name, FILE_LIMIT)`.
    fn read(&mut self, name: &str) -> Result<Vec<u8>, HistoryRefused>;
    /// `freshness_tail(root / name)`.
    fn tail(&mut self, name: &str) -> Result<Tail, HistoryRefused>;
    /// Whether the 5 s read deadline has passed.
    fn expired(&self) -> bool;
    /// The post-read configuration and state-directory recheck.
    fn recheck(&mut self) -> Result<(), HistoryRefused>;
}

pub(crate) fn text(value: &str) -> Text {
    Text(value.chars().map(u32::from).collect())
}

pub(crate) fn field<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
    match &value.0 {
        Node::Object(fields) => fields.get(&text(name)),
        _ => None,
    }
}

/// `type(value) is int`, as i128 (wider JSON integers never fit any bound).
pub(crate) fn integer(value: Option<&Value>) -> Option<i128> {
    match value {
        Some(Value(Node::Number(Number::Integer(digits)))) => digits.parse().ok(),
        _ => None,
    }
}

/// `canonical(value)`: an absolute pathlib-normal path text with no `..`
/// part and no ASCII control character.
#[must_use]
pub fn canonical_path(points: &[u32]) -> bool {
    let Some(rest) = points.strip_prefix(&[u32::from('/')]) else {
        return false;
    };
    let rest = rest
        .strip_prefix(&[u32::from('/')])
        .filter(|after| after.first() != Some(&u32::from('/')))
        .unwrap_or(rest);
    let parts = rest
        .split(|point| *point == u32::from('/'))
        .collect::<Vec<_>>();
    let normal = rest.is_empty()
        || parts.iter().all(|part| {
            !part.is_empty()
                && *part != [u32::from('.')]
                && *part != [u32::from('.'), u32::from('.')]
        });
    normal && points.iter().all(|point| *point >= 32 && *point != 127)
}

fn string(value: Option<&Value>) -> Result<Vec<u32>, HistoryRefused> {
    match value {
        Some(Value(Node::String(text))) => Ok(text.0.clone()),
        _ => Err(HistoryRefused("TypeError")),
    }
}

fn limit(value: Option<&Value>, low: i128, high: i128) -> Result<i64, HistoryRefused> {
    integer(value)
        .filter(|value| (low..=high).contains(value))
        .and_then(|value| i64::try_from(value).ok())
        .ok_or(HistoryRefused("Observation limit refused"))
}

const CONFIG_KEYS: [&str; 8] = [
    "version",
    "mode",
    "stateDirectory",
    "intervalSeconds",
    "retentionDays",
    "rollupRetentionDays",
    "drives",
    "gpuExecutable",
];

/// The JSON rules of `collector_user.configuration`: exactly the eight keys,
/// integer version 1, mode, canonical paths, limits and drive labels.
pub fn parse_observation_config(raw: &[u8]) -> Result<ObservationConfig, HistoryRefused> {
    let value = legacy_json::decode_metadata_bytes(raw)
        .map_err(|_| HistoryRefused("Invalid configuration JSON"))?;
    let unsupported = HistoryRefused("Unsupported user observation configuration");
    let Node::Object(fields) = &value.0 else {
        return Err(unsupported);
    };
    let exact = fields.len() == CONFIG_KEYS.len()
        && CONFIG_KEYS
            .iter()
            .all(|key| fields.contains_key(&text(key)));
    let mode = matches!(field(&value, "mode"), Some(Value(Node::String(mode))) if mode.equals_ascii("user-observations"));
    if !exact || integer(field(&value, "version")) != Some(1) || !mode {
        return Err(unsupported);
    }
    let state_directory = string(field(&value, "stateDirectory"))?;
    if !canonical_path(&state_directory) {
        return Err(HistoryRefused("Canonical absolute path required"));
    }
    let config = ObservationConfig {
        state_directory,
        interval_seconds: limit(field(&value, "intervalSeconds"), 30, 86400)?,
        retention_days: limit(field(&value, "retentionDays"), 1, 365)?,
        rollup_retention_days: limit(field(&value, "rollupRetentionDays"), 1, 3650)?,
        drives: drives(field(&value, "drives"))?,
        gpu_executable: match field(&value, "gpuExecutable") {
            Some(Value(Node::Null)) => None,
            other => Some(string(other)?)
                .filter(|path| canonical_path(path))
                .map(Some)
                .ok_or(HistoryRefused("Canonical absolute path required"))?,
        },
    };
    Ok(config)
}

/// Drive labels and their mount paths, as Python `str` code points.
pub type Drives = Vec<(Vec<u32>, Vec<u32>)>;

fn drives(value: Option<&Value>) -> Result<Drives, HistoryRefused> {
    let Some(Value(Node::Object(drives))) = value else {
        return Err(HistoryRefused("Drive labels refused"));
    };
    if drives.len() > 16 {
        return Err(HistoryRefused("Drive labels refused"));
    }
    let label_ok = |label: &Text| {
        let chars = label
            .0
            .iter()
            .map(|point| char::from_u32(*point).unwrap_or('\u{fffd}'))
            .collect::<Vec<_>>();
        (1..=32).contains(&chars.len())
            && chars[0].is_ascii_alphanumeric()
            && chars[1..]
                .iter()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
    };
    let mut out = Vec::new();
    for (label, path) in drives {
        if !label_ok(label) {
            return Err(HistoryRefused("Drive label refused"));
        }
        let path = string(Some(path))?;
        if !canonical_path(&path) {
            return Err(HistoryRefused("Canonical absolute path required"));
        }
        out.push((label.0.clone(), path));
    }
    Ok(out)
}

/// `query`: the projection's exact output bytes (without the newline).
pub fn query(
    source: &mut dyn HistorySource,
    config: &ObservationConfig,
    request: &HistoryRequest,
) -> Result<Vec<u8>, HistoryRefused> {
    let plan = scan::Plan::new(config, request)?;
    let scanned = scan::scan(source, &plan, request)?;
    let projection = points::project(source, &plan, request, scanned)?;
    source.recheck()?;
    let output = points::encode(config, request, &plan, &projection);
    if output.len() > OUTPUT_LIMIT {
        return Err(HistoryRefused("History output bound exceeded"));
    }
    Ok(output)
}
