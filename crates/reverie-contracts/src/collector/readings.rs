//! The readings of one sample, parsed from bounded text exactly as the
//! collector does. Errors carry the Python exception class name it records.
use super::{Out, splitlines};
use crate::python_number::round;

const VALUE: &str = "ValueError";
const INPUT: &str = "InputError";

/// Python `int(text)` for ASCII digits: optional sign, surrounding
/// whitespace and single underscores between digits.
pub fn python_int(text: &str) -> Option<i128> {
    let text = text.trim();
    let (negative, digits) = match text.as_bytes().first() {
        Some(b'-') => (true, &text[1..]),
        Some(b'+') => (false, &text[1..]),
        _ => (false, text),
    };
    let plain = underscored(digits, |c| c.is_ascii_digit())?;
    let value = plain.parse::<i128>().ok()?;
    Some(if negative { -value } else { value })
}

/// Digits with optional single underscores between them, underscores removed.
fn underscored(text: &str, digit: impl Fn(char) -> bool) -> Option<String> {
    let mut plain = String::new();
    let mut previous_digit = false;
    for c in text.chars() {
        if c == '_' {
            if !previous_digit {
                return None;
            }
            previous_digit = false;
        } else {
            previous_digit = digit(c);
            plain.push(c);
        }
    }
    (!text.is_empty() && !text.ends_with('_')).then_some(plain)
}

/// Python `float(text)`: whitespace, a sign, `inf`/`infinity`/`nan` in any
/// case, and underscores only between digits.
pub fn python_float(text: &str) -> Option<f64> {
    let text = text.trim();
    let body = text.strip_prefix(['+', '-']).unwrap_or(text);
    let lower = body.to_ascii_lowercase();
    if matches!(lower.as_str(), "inf" | "infinity" | "nan") {
        let value = if lower == "nan" {
            f64::NAN
        } else {
            f64::INFINITY
        };
        return Some(if text.starts_with('-') { -value } else { value });
    }
    if !body.starts_with(|c: char| c.is_ascii_digit() || c == '.') {
        return None;
    }
    let plain = if text.contains('_') {
        // An underscore must sit between two digits.
        let bytes = text.as_bytes();
        let ok = bytes.iter().enumerate().all(|(at, byte)| {
            *byte != b'_'
                || (at > 0
                    && bytes[at - 1].is_ascii_digit()
                    && bytes.get(at + 1).is_some_and(u8::is_ascii_digit))
        });
        if !ok {
            return None;
        }
        text.replace('_', "")
    } else {
        text.to_owned()
    };
    plain.parse().ok()
}

/// `cpu_times`: `((total, idle), cores)` from `/proc/stat`.
pub fn cpu_times(text: &str) -> Result<((i128, i128), i64), &'static str> {
    let first = text.split('\n').next().unwrap_or_default();
    let fields = first.split_whitespace().collect::<Vec<_>>();
    if fields.first() != Some(&"cpu") || fields.len() < 5 {
        return Err(INPUT);
    }
    let values = fields[1..]
        .iter()
        .map(|field| python_int(field))
        .collect::<Option<Vec<_>>>()
        .ok_or(VALUE)?;
    let total = values
        .iter()
        .take(8)
        .try_fold(0i128, |sum, value| sum.checked_add(*value));
    let idle = values[3].checked_add(values.get(4).copied().unwrap_or(0));
    let cores = splitlines(text)
        .iter()
        .filter(|line| {
            line.strip_prefix("cpu").is_some_and(|rest| {
                let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
                digits > 0 && rest[digits..].starts_with(' ')
            })
        })
        .count();
    match (total, idle) {
        (Some(total), Some(idle)) => Ok(((total, idle), i64::try_from(cores).unwrap_or(i64::MAX))),
        _ => Err(VALUE),
    }
}

/// `cpu_pct(prev, cur)` over Python numbers converted to floats as Python
/// does for `100.0 * (total - idle) / total`.
#[allow(clippy::cast_precision_loss)]
pub fn cpu_pct(previous: (f64, f64), current: (i128, i128)) -> Option<f64> {
    let total = current.0 as f64 - previous.0;
    let idle = current.1 as f64 - previous.1;
    (total > 0.0 && (0.0..=total).contains(&idle)).then(|| round(100.0 * (total - idle) / total, 2))
}

/// `loadavg`: the first three fields, finite and non-negative.
pub fn loadavg(text: &str) -> Result<Out, &'static str> {
    let parts = text.split_whitespace().take(3).collect::<Vec<_>>();
    if parts.len() < 3 {
        return Err(VALUE);
    }
    let values = parts
        .iter()
        .map(|part| python_float(part))
        .collect::<Option<Vec<_>>>()
        .ok_or(VALUE)?;
    if !values
        .iter()
        .all(|value| value.is_finite() && *value >= 0.0)
    {
        return Err(INPUT);
    }
    Ok(Out::map([
        ("load1", Out::Float(values[0])),
        ("load5", Out::Float(values[1])),
        ("load15", Out::Float(values[2])),
    ]))
}

/// `memory`: `(mem_pct, {"total", "available"})` from `/proc/meminfo`.
#[allow(clippy::cast_precision_loss)]
pub fn memory(text: &str) -> Result<(f64, Out), &'static str> {
    let mut total = None;
    let mut free = None;
    let mut available = None;
    for line in splitlines(text) {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let Some(first) = value.split_whitespace().next() else {
            continue;
        };
        if !first.bytes().all(|byte| byte.is_ascii_digit()) {
            continue;
        }
        let bytes = first
            .parse::<i128>()
            .map_err(|_| VALUE)?
            .checked_mul(1024)
            .ok_or(VALUE)?;
        match key {
            "MemTotal" => total = Some(bytes),
            "MemFree" => free = Some(bytes),
            "MemAvailable" => available = Some(bytes),
            _ => {}
        }
    }
    let available = available.or(free);
    match (total, available) {
        (Some(total), Some(available)) if total != 0 && (0..=total).contains(&available) => {
            let percent = round(100.0 * (total - available) as f64 / total as f64, 2);
            Ok((
                percent,
                Out::map([
                    ("total", Out::int(total)),
                    ("available", Out::int(available)),
                ]),
            ))
        }
        _ => Err(INPUT),
    }
}

/// One GPU of a reading, with its stable identity when trustworthy.
#[derive(Clone, Debug, PartialEq)]
pub struct GpuDevice {
    pub index: i128,
    pub util_pct: f64,
    /// `(mem_used_mib, mem_total_mib)`; `None` for a sysfs reading.
    pub memory: Option<(f64, f64)>,
    pub uuid: Option<String>,
    pub identity_status: &'static str,
}

/// The `gpu` reading and its `gpu_pct`.
#[derive(Clone, Debug, PartialEq)]
pub enum Gpu {
    Off,
    Devices {
        source: &'static str,
        devices: Vec<GpuDevice>,
    },
    None,
    Error,
}

impl GpuDevice {
    fn out(&self) -> Out {
        let mut device = Out::map([
            ("index", Out::int(self.index)),
            ("util_pct", Out::Float(self.util_pct)),
            ("uuid", self.uuid.as_deref().map_or(Out::Null, Out::text)),
            ("identity_status", Out::text(self.identity_status)),
        ]);
        if let Some((used, total)) = self.memory {
            device.set("mem_used_mib", Out::Float(used));
            device.set("mem_total_mib", Out::Float(total));
        }
        device
    }
}

impl Gpu {
    /// `(gpu_pct, gpu)` as the sample records them.
    #[allow(clippy::cast_precision_loss)]
    pub fn out(&self) -> (Out, Out) {
        let block = |status: &str, source: &str, devices: Vec<Out>| {
            Out::map([
                ("status", Out::text(status)),
                ("source", Out::text(source)),
                ("devices", Out::List(devices)),
            ])
        };
        match self {
            Self::Off => (Out::Null, block("unavailable", "off", Vec::new())),
            Self::None => (Out::Null, block("unavailable", "none", Vec::new())),
            Self::Error => (Out::Null, block("error", "none", Vec::new())),
            Self::Devices { source, devices } => {
                let sum = devices.iter().map(|device| device.util_pct).sum::<f64>();
                let percent = round(sum / devices.len() as f64, 2);
                let listed = devices.iter().map(GpuDevice::out).collect();
                (Out::Float(percent), block("ok", source, listed))
            }
        }
    }
}

/// `GPU-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`, any hex case.
pub(super) fn nvidia_uuid(text: &str) -> bool {
    let Some(rest) = text.strip_prefix("GPU-") else {
        return false;
    };
    let parts = rest.split('-').collect::<Vec<_>>();
    parts.len() == 5
        && parts
            .iter()
            .zip([8usize, 4, 4, 4, 12])
            .all(|(part, width)| {
                part.len() == width && part.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
}

/// The `nvidia-smi --query-gpu=index,utilization.gpu,memory.used,memory.total,uuid`
/// CSV rows: `None` where the reading falls back to sysfs.
pub fn nvidia_devices(output: &str) -> Option<Vec<GpuDevice>> {
    let rows = splitlines(output.trim());
    let mut devices = Vec::new();
    // Identities of every parsed row, kept or not, as Python counts them.
    let mut seen: Vec<String> = Vec::new();
    for line in rows.iter().take(64) {
        let fields = line.split(',').map(str::trim).collect::<Vec<_>>();
        if !(4..=5).contains(&fields.len()) {
            return None;
        }
        let identity = fields.get(4).copied().unwrap_or_default();
        let (uuid, identity_status) = if nvidia_uuid(identity) {
            (
                Some(format!("GPU-{}", identity[4..].to_ascii_lowercase())),
                "available",
            )
        } else if matches!(identity, "" | "N/A" | "[Not Supported]") {
            (None, "unavailable")
        } else {
            (None, "invalid")
        };
        let index = python_int(fields[0])?;
        if let Some(uuid) = &uuid {
            seen.push(uuid.clone());
        }
        let util = python_float(fields[1])?;
        let used = python_float(fields[2])?;
        let total = python_float(fields[3])?;
        let finite = |value: f64, high: Option<f64>| {
            value.is_finite() && value >= 0.0 && high.is_none_or(|high| value <= high)
        };
        if finite(util, Some(100.0)) && finite(used, None) && finite(total, None) {
            devices.push(GpuDevice {
                index,
                util_pct: util,
                memory: Some((used, total)),
                uuid,
                identity_status,
            });
        }
    }
    // Never keep one arbitrary member of a duplicate identity set; a capped
    // listing cannot establish uniqueness across omitted rows.
    let capped = rows.len() > 64;
    let duplicates = seen
        .iter()
        .filter(|uuid| seen.iter().filter(|other| other == uuid).count() > 1)
        .cloned()
        .collect::<Vec<_>>();
    for device in &mut devices {
        if capped {
            device.uuid = None;
            device.identity_status = "incomplete";
        } else if device
            .uuid
            .as_ref()
            .is_some_and(|uuid| duplicates.contains(uuid))
        {
            device.uuid = None;
            device.identity_status = "duplicate";
        }
    }
    (!devices.is_empty()).then_some(devices)
}
