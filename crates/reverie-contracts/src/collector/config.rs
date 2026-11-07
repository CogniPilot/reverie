//! `load_config`: a TOML table over `DEFAULTS`, with the original checks and
//! error text after the `config: ` prefix.
use super::{Out, points};
use crate::collector_state::repr;
use std::collections::BTreeMap;
use toml::{Table, Value};

/// The validated collector configuration (`cfg`).
#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    pub out_dir: String,
    pub label: Out,
    pub interval_s: i64,
    pub retention_days: i64,
    pub rollup_retention_days: i64,
    pub drives: BTreeMap<String, String>,
    pub prune_log_dir: String,
    pub gpu_auto: bool,
    pub nvidia_smi: String,
    pub max_input_bytes: i64,
    pub max_prune_join: i64,
    pub max_file_bytes: i64,
    pub proc_root: String,
    pub sys_root: String,
    /// The whole environment of the GPU tool; `None` inherits this process's.
    pub environment: Option<Vec<(std::ffi::OsString, std::ffi::OsString)>>,
}

impl Default for Config {
    /// `DEFAULTS`.
    fn default() -> Self {
        Self {
            out_dir: "/var/lib/reverie/collect".into(),
            label: Out::Null,
            interval_s: 300,
            retention_days: 30,
            rollup_retention_days: 400,
            drives: BTreeMap::new(),
            prune_log_dir: String::new(),
            gpu_auto: true,
            nvidia_smi: "nvidia-smi".into(),
            max_input_bytes: 1 << 20,
            max_prune_join: 50,
            max_file_bytes: 64 << 20,
            proc_root: "/proc".into(),
            sys_root: "/sys".into(),
            environment: None,
        }
    }
}

const KEYS: [&str; 14] = [
    "out_dir",
    "label",
    "interval_s",
    "retention_days",
    "rollup_retention_days",
    "drives",
    "prune_log_dir",
    "gpu",
    "nvidia_smi",
    "max_input_bytes",
    "max_prune_join",
    "max_file_bytes",
    "proc_root",
    "sys_root",
];
const POSITIVE: [&str; 6] = [
    "interval_s",
    "retention_days",
    "rollup_retention_days",
    "max_input_bytes",
    "max_prune_join",
    "max_file_bytes",
];

/// TOML data as the JSON `label` value; `None` for a date or time, which
/// Python cannot serialize, or a non-finite float.
fn label(value: &Value) -> Option<Out> {
    Some(match value {
        Value::String(text) => Out::text(text),
        Value::Integer(number) => Out::int(number),
        Value::Float(number) if number.is_finite() => Out::Float(*number),
        Value::Boolean(flag) => Out::Bool(*flag),
        Value::Array(values) => Out::List(values.iter().map(label).collect::<Option<_>>()?),
        Value::Table(table) => Out::Map(
            table
                .iter()
                .map(|(key, value)| Some((points(key), label(value)?)))
                .collect::<Option<_>>()?,
        ),
        Value::Float(_) | Value::Datetime(_) => return None,
    })
}

fn text(raw: &Table, key: &str, default: &str) -> Result<String, String> {
    match raw.get(key) {
        None => Ok(default.to_owned()),
        Some(Value::String(text)) => Ok(text.clone()),
        Some(_) => Err(format!("config: {key} must be a string")),
    }
}

fn positive(raw: &Table, key: &str, default: i64) -> Result<i64, String> {
    match raw.get(key) {
        None => Ok(default),
        Some(Value::Integer(number)) if *number > 0 => Ok(*number),
        Some(_) => Err(format!("config: {key} must be a positive integer")),
    }
}

/// `load_config(path)` after the file was read: `Err` is the message after
/// `reverie-collect: `.
pub fn parse_config(source: &str) -> Result<Config, String> {
    let raw: Table = source.parse().map_err(|error: toml::de::Error| {
        let message = error
            .message()
            .lines()
            .next()
            .unwrap_or_default()
            .to_owned();
        format!("config: {message}")
    })?;
    let unknown = raw
        .keys()
        .filter(|key| !KEYS.contains(&key.as_str()))
        .map(|key| repr(&points(key)))
        .collect::<Vec<_>>();
    if !unknown.is_empty() {
        return Err(format!("config: unknown keys [{}]", unknown.join(", ")));
    }
    let defaults = Config::default();
    let drives = match raw.get("drives") {
        None => BTreeMap::new(),
        Some(Value::Table(table)) => table
            .iter()
            .map(|(name, path)| match path {
                Value::String(path) => Ok((name.clone(), path.clone())),
                _ => Err(()),
            })
            .collect::<Result<_, ()>>()
            .map_err(|()| "config: drives must be a table of name = path".to_owned())?,
        Some(_) => return Err("config: drives must be a table of name = path".into()),
    };
    let mut numbers = [0i64; 6];
    for (slot, key) in numbers.iter_mut().zip(POSITIVE) {
        let default = match key {
            "interval_s" => defaults.interval_s,
            "retention_days" => defaults.retention_days,
            "rollup_retention_days" => defaults.rollup_retention_days,
            "max_input_bytes" => defaults.max_input_bytes,
            "max_prune_join" => defaults.max_prune_join,
            _ => defaults.max_file_bytes,
        };
        *slot = positive(&raw, key, default)?;
    }
    let gpu_auto = match raw.get("gpu") {
        None => true,
        Some(Value::String(mode)) if mode == "auto" => true,
        Some(Value::String(mode)) if mode == "off" => false,
        Some(_) => return Err("config: gpu must be auto or off".into()),
    };
    let label = match raw.get("label") {
        None => Out::Null,
        Some(value) => label(value).ok_or_else(|| "config: label must be JSON data".to_owned())?,
    };
    let [
        interval_s,
        retention_days,
        rollup_retention_days,
        max_input_bytes,
        max_prune_join,
        max_file_bytes,
    ] = numbers;
    Ok(Config {
        out_dir: text(&raw, "out_dir", &defaults.out_dir)?,
        label,
        interval_s,
        retention_days,
        rollup_retention_days,
        drives,
        prune_log_dir: text(&raw, "prune_log_dir", &defaults.prune_log_dir)?,
        gpu_auto,
        nvidia_smi: text(&raw, "nvidia_smi", &defaults.nvidia_smi)?,
        max_input_bytes,
        max_prune_join,
        max_file_bytes,
        proc_root: text(&raw, "proc_root", &defaults.proc_root)?,
        sys_root: text(&raw, "sys_root", &defaults.sys_root)?,
        environment: None,
    })
}
