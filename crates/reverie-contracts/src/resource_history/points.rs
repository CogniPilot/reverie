//! Bucket projection (`statistics`, `combine`) and the exact output bytes.
use super::scan::{Plan, Scanned, gpu_uuid};
use super::{
    HistoryRefused, HistoryRequest, HistorySource, MAX_ROWS, ObservationConfig, field, integer,
};
use crate::legacy_json::{Node, Value};
use crate::python_number::PythonNumber;
use crate::worker_config::python_float_repr;
use std::collections::{BTreeMap, BTreeSet};

/// `{'min', 'avg', 'max', 'n'}` with the original number objects.
#[derive(Clone, Copy)]
pub(super) struct Stat {
    min: PythonNumber,
    avg: PythonNumber,
    max: PythonNumber,
    n: i128,
}

fn percent(value: Option<&Value>) -> Option<PythonNumber> {
    let number = PythonNumber::of(value?)?;
    (number.is_finite() && PythonNumber::Int(0).le(number) && number.le(PythonNumber::Int(100)))
        .then_some(number)
}

/// `statistics(value)`.
fn statistics(value: Option<&Value>) -> Option<Stat> {
    if let Some(number) = percent(value) {
        return Some(Stat {
            min: number,
            avg: number,
            max: number,
            n: 1,
        });
    }
    let value = value?;
    let Node::Object(fields) = &value.0 else {
        return None;
    };
    if fields.len() != 4 {
        return None;
    }
    let (min, avg, max) = (
        percent(field(value, "min"))?,
        percent(field(value, "avg"))?,
        percent(field(value, "max"))?,
    );
    let n = integer(field(value, "n")).filter(|n| (1..=1_000_000).contains(n))?;
    (min.le(avg) && avg.le(max)).then_some(Stat { min, avg, max, n })
}

/// Python's `round(x, 3)`: the double nearest the correctly rounded decimal.
fn round3(value: f64) -> f64 {
    format!("{value:.3}").parse().unwrap_or(value)
}

/// `combine(values)`: first minimal/maximal objects, an int count, and the
/// count-weighted average in Python's evaluation order.
fn combine(values: &[Option<Stat>]) -> Option<Stat> {
    let present = values.iter().flatten().copied().collect::<Vec<_>>();
    let n = present.iter().map(|stat| stat.n).sum::<i128>();
    if n == 0 {
        return None;
    }
    let mut min = present[0].min;
    let mut max = present[0].max;
    let mut total = PythonNumber::Int(0);
    for stat in &present {
        if stat.min.lt(min) {
            min = stat.min;
        }
        if max.lt(stat.max) {
            max = stat.max;
        }
        total = total.plus(stat.avg.times(PythonNumber::Int(stat.n))?)?;
    }
    Some(Stat {
        min,
        avg: PythonNumber::Float(round3(total.divided_by(n))),
        max,
        n,
    })
}

/// One output point.
pub(super) struct Point {
    t: i64,
    end: i64,
    cpu: Option<Stat>,
    mem: Option<Stat>,
    gpu: Option<Stat>,
    samples: i128,
    status: &'static str,
    identity_missing: Option<i128>,
}

pub(super) struct Projection {
    points: Vec<Point>,
    devices: BTreeSet<String>,
    scanned: Scanned,
}

/// The device list of one row: raw `gpu.devices`, else rollup `gpu_devices`.
fn listed(row: &Value, raw: bool) -> Option<&Vec<Value>> {
    let list = match field(row, "gpu") {
        Some(gpu @ Value(Node::Object(inner))) if raw => {
            if inner.is_empty() {
                None
            } else {
                field(gpu, "devices")
            }
        }
        _ => field(row, "gpu_devices"),
    };
    match list {
        Some(Value(Node::Array(items))) => Some(items),
        _ => None,
    }
}

fn string_field(value: &Value, name: &str) -> Option<String> {
    match field(value, name) {
        Some(Value(Node::String(text))) => {
            text.0.iter().map(|point| char::from_u32(*point)).collect()
        }
        _ => None,
    }
}

fn available(device: &Value, raw: bool) -> bool {
    !raw || string_field(device, "identity_status").as_deref() == Some("available")
}

struct Bucket<'a> {
    rows: Vec<&'a Value>,
    raw: bool,
}

fn bucket_rows(scanned: &Scanned, step: i64) -> BTreeMap<i64, (Vec<&Value>, Vec<&Value>)> {
    let mut buckets: BTreeMap<i64, (Vec<&Value>, Vec<&Value>)> = BTreeMap::new();
    for row in &scanned.rows {
        let entry = buckets.entry(row.t - row.t % step).or_default();
        if row.raw {
            entry.0.push(&row.value)
        } else {
            entry.1.push(&row.value)
        }
    }
    buckets
}

pub(super) fn project(
    source: &dyn HistorySource,
    plan: &Plan,
    request: &HistoryRequest,
    scanned: Scanned,
) -> Result<Projection, HistoryRefused> {
    let step = plan.step;
    let buckets = bucket_rows(&scanned, step);
    let mut devices = BTreeSet::new();
    let mut points = Vec::new();
    let mut t = plan.origin;
    while t < request.end {
        if source.expired() {
            return Err(HistoryRefused("History read deadline exceeded"));
        }
        let bucket = match buckets.get(&t) {
            Some((raw, _)) if !raw.is_empty() => Bucket {
                rows: raw.clone(),
                raw: true,
            },
            Some((_, rollup)) => Bucket {
                rows: rollup.clone(),
                raw: false,
            },
            None => Bucket {
                rows: Vec::new(),
                raw: false,
            },
        };
        points.push(point(t, &bucket, plan, request, &mut devices)?);
        t += step;
    }
    Ok(Projection {
        points,
        devices,
        scanned,
    })
}

fn point(
    t: i64,
    bucket: &Bucket<'_>,
    plan: &Plan,
    request: &HistoryRequest,
    devices: &mut BTreeSet<String>,
) -> Result<Point, HistoryRefused> {
    let (mut cpu, mut mem, mut gpu) = (Vec::new(), Vec::new(), Vec::new());
    let mut missing: i128 = 0;
    for row in &bucket.rows {
        record_devices(row, bucket.raw, devices)?;
        cpu.push(statistics(field(row, "cpu_pct")));
        mem.push(statistics(field(row, "mem_pct")));
        match request.gpu.as_deref() {
            None => gpu.push(statistics(field(row, "gpu_pct"))),
            Some(wanted) => missing += selected_gpu(row, bucket.raw, wanted, &mut gpu),
        }
    }
    let (cpu, mem, gpu) = (combine(&cpu), combine(&mem), combine(&gpu));
    let observed = if bucket.raw {
        i128::try_from(bucket.rows.len()).unwrap_or(i128::MAX)
    } else {
        bucket
            .rows
            .iter()
            .filter_map(|row| integer(field(row, "samples")).filter(|n| (0..=MAX_ROWS).contains(n)))
            .sum()
    };
    let expected = i128::from((plan.step / plan.interval).max(1));
    let status = if bucket.rows.is_empty() {
        "missing"
    } else if cpu.is_none() || mem.is_none() || gpu.is_none() || missing != 0 || observed < expected
    {
        "partial"
    } else {
        "observed"
    };
    Ok(Point {
        t,
        end: request.end.min(t + plan.step),
        cpu,
        mem,
        gpu,
        samples: observed,
        status,
        identity_missing: request.gpu.as_ref().map(|_| missing),
    })
}

fn record_devices(
    row: &Value,
    raw: bool,
    devices: &mut BTreeSet<String>,
) -> Result<(), HistoryRefused> {
    for device in listed(row, raw).map_or(&[][..], |list| &list[..list.len().min(64)]) {
        if let Some(uuid) = string_field(device, "uuid").filter(|uuid| gpu_uuid(uuid))
            && matches!(device.0, Node::Object(_))
            && available(device, raw)
        {
            devices.insert(uuid);
        }
    }
    if devices.len() > 64 {
        return Err(HistoryRefused("History identity bound exceeded"));
    }
    Ok(())
}

/// The selected GPU's utilization, returning the missing-identity count.
fn selected_gpu(row: &Value, raw: bool, wanted: &str, values: &mut Vec<Option<Stat>>) -> i128 {
    let matches = listed(row, raw).map_or_else(Vec::new, |list| {
        list.iter()
            .filter(|device| {
                string_field(device, "uuid").as_deref() == Some(wanted) && available(device, raw)
            })
            .collect::<Vec<_>>()
    });
    if let [only] = matches[..] {
        values.push(statistics(field(only, "util_pct")));
        if raw {
            return 0;
        }
        return integer(field(only, "missing_samples"))
            .filter(|n| (0..=MAX_ROWS).contains(n))
            .unwrap_or(1);
    }
    match integer(field(row, "samples")) {
        Some(n) if !raw && (0..=MAX_ROWS).contains(&n) => n,
        _ => 1,
    }
}

/// A compact ASCII JSON writer in insertion order (`separators=(',', ':')`).
struct Writer(String);
impl Writer {
    fn key(&mut self, name: &str) {
        if !self.0.ends_with('{') {
            self.0.push(',');
        }
        self.string(name);
        self.0.push(':');
    }
    fn string(&mut self, text: &str) {
        self.0.push('"');
        for c in text.chars() {
            match c {
                '"' => self.0.push_str("\\\""),
                '\\' => self.0.push_str("\\\\"),
                c if (c as u32) < 0x20 || !c.is_ascii() => {
                    self.0.push_str(&format!("\\u{:04x}", c as u32))
                }
                c => self.0.push(c),
            }
        }
        self.0.push('"');
    }
    fn number(&mut self, number: PythonNumber) {
        match number {
            PythonNumber::Int(value) => self.0.push_str(&value.to_string()),
            PythonNumber::Float(value) => self.0.push_str(&python_float_repr(value)),
        }
    }
    fn stat(&mut self, stat: Option<Stat>) {
        let Some(stat) = stat else {
            self.0.push_str("null");
            return;
        };
        self.0.push('{');
        self.key("min");
        self.number(stat.min);
        self.key("avg");
        self.number(stat.avg);
        self.key("max");
        self.number(stat.max);
        self.key("n");
        self.0.push_str(&stat.n.to_string());
        self.0.push('}');
    }
    fn optional(&mut self, value: Option<String>) {
        match value {
            Some(text) => self.0.push_str(&text),
            None => self.0.push_str("null"),
        }
    }
}

fn freshness(request: &HistoryRequest, plan: &Plan, scanned: &Scanned) -> &'static str {
    match scanned.latest {
        None if scanned.raw_files > 0 => "unavailable",
        None => "missing",
        Some(latest) if request.now - latest > (2 * plan.interval).max(60) => "stale",
        Some(_) => "fresh",
    }
}

pub(super) fn encode(
    config: &ObservationConfig,
    request: &HistoryRequest,
    plan: &Plan,
    projection: &Projection,
) -> Vec<u8> {
    let mut w = Writer(String::from("{"));
    let scanned = &projection.scanned;
    let fixed = |w: &mut Writer, key: &str, value: &str| {
        w.key(key);
        w.string(value);
    };
    w.key("version");
    w.0.push('1');
    fixed(&mut w, "scope", "shared-host-unattributed-observations");
    fixed(&mut w, "sourceMode", "user-observations");
    for (key, value) in [
        ("start", request.start),
        ("end", request.end),
        ("bucketSeconds", plan.step),
    ] {
        w.key(key);
        w.0.push_str(&value.to_string());
    }
    w.key("gpuUUID");
    match &request.gpu {
        Some(gpu) => w.string(gpu),
        None => w.0.push_str("null"),
    }
    w.key("deviceUUIDs");
    w.0.push('[');
    for (index, device) in projection.devices.iter().enumerate() {
        if index > 0 {
            w.0.push(',');
        }
        w.string(device);
    }
    w.0.push(']');
    fixed(&mut w, "deviceUUIDsScope", "queried-records");
    w.key("lastSampleAt");
    w.optional(scanned.latest.map(|t| t.to_string()));
    fixed(&mut w, "freshness", freshness(request, plan, scanned));
    fixed(&mut w, "freshnessSource", "bounded-latest-raw-tail");
    w.key("freshnessReadComplete");
    w.0.push_str(if scanned.freshness_complete {
        "true"
    } else {
        "false"
    });
    for (key, value) in [
        ("intervalSeconds", config.interval_seconds),
        ("retentionDays", config.retention_days),
        ("rollupRetentionDays", config.rollup_retention_days),
    ] {
        w.key(key);
        w.0.push_str(&value.to_string());
    }
    w.key("malformedLines");
    w.0.push_str(&scanned.reader.malformed.to_string());
    fixed(&mut w, "malformedLinesScope", "read-records");
    w.key("points");
    encode_points(&mut w, &projection.points);
    w.key("effectAuthority");
    w.0.push_str("false");
    w.key("employeeAttribution");
    w.0.push_str("null");
    fixed(
        &mut w,
        "historicalDeviceCoverage",
        "only-recorded-valid-UUIDs; legacy-rollups-have-no-device-history",
    );
    w.0.push('}');
    w.0.into_bytes()
}

fn encode_points(w: &mut Writer, points: &[Point]) {
    w.0.push('[');
    for (index, point) in points.iter().enumerate() {
        if index > 0 {
            w.0.push(',');
        }
        w.0.push('{');
        w.key("t");
        w.0.push_str(&point.t.to_string());
        w.key("end");
        w.0.push_str(&point.end.to_string());
        for (key, stat) in [
            ("cpu_pct", point.cpu),
            ("mem_pct", point.mem),
            ("gpu_pct", point.gpu),
        ] {
            w.key(key);
            w.stat(stat);
        }
        w.key("samples");
        w.0.push_str(&point.samples.to_string());
        w.key("status");
        w.string(point.status);
        w.key("deviceIdentityMissing");
        w.optional(point.identity_missing.map(|n| n.to_string()));
        w.0.push('}');
    }
    w.0.push(']');
}
