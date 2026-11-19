use serde::Serialize;
use std::{
    io,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Gpu {
    name: String,
    utilization: f64,
    memory_used_mb: f64,
    memory_total_mb: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    updated_at: u128,
    gpus: Vec<Gpu>,
}

pub(super) fn encode(gpus: Vec<Gpu>) -> io::Result<Vec<u8>> {
    let snapshot = Snapshot {
        updated_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(io::Error::other)?
            .as_millis(),
        gpus,
    };
    let mut bytes = serde_json::to_vec(&snapshot)?;
    bytes.push(b'\n');
    Ok(bytes)
}

pub(super) fn parse(bytes: &[u8]) -> Option<Vec<Gpu>> {
    let text = String::from_utf8_lossy(bytes);
    let mut gpus = Vec::new();
    for line in text.trim().lines() {
        if gpus.len() == 64 {
            return None;
        }
        gpus.push(gpu(line)?);
    }
    (!gpus.is_empty()).then_some(gpus)
}

fn gpu(line: &str) -> Option<Gpu> {
    let mut fields = line.rsplitn(4, ',').map(str::trim);
    let total = fields.next()?;
    let used = fields.next()?;
    let utilization = number(fields.next()?)?;
    let memory_used_mb = number(used)?;
    let memory_total_mb = number(total)?;
    let name = fields
        .next()?
        .split(',')
        .map(str::trim)
        .collect::<Vec<_>>()
        .join(", ");
    if name.is_empty() || name.encode_utf16().count() > 256 || name.chars().any(|c| c < '\u{20}') {
        return None;
    }
    (utilization <= 100.0
        && memory_total_mb > 0.0
        && memory_total_mb <= 1_000_000_000.0
        && memory_used_mb <= memory_total_mb)
        .then_some(Gpu {
            name,
            utilization,
            memory_used_mb,
            memory_total_mb,
        })
}

fn number(value: &str) -> Option<f64> {
    fn digits(value: &str) -> bool {
        !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
    }
    let valid = match value.split_once('.') {
        Some((whole, fractional)) => digits(whole) && digits(fractional),
        None => digits(value),
    };
    valid
        .then(|| value.parse::<f64>().ok())
        .flatten()
        .filter(|value| value.is_finite())
}
