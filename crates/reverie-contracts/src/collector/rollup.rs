//! `agg`, `gpu_rollup`, `rollup`, `roll`, `last_rolled` and the retention
//! windows: closed hourly and daily periods, each appended at most once.
use super::readings::nvidia_uuid;
use super::{Out, Record, finite, number, points, text_of};
use crate::legacy_json::{Node, Value};
use crate::python_number::{PythonNumber, round};
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};

/// `agg(vals)`: the first minimal and maximal objects, the rounded mean and
/// the count of the finite values, or `None`.
fn agg<'a>(values: impl IntoIterator<Item = Option<&'a Value>>) -> Out {
    let present = values.into_iter().filter_map(finite).collect::<Vec<_>>();
    let Some(&first) = present.first() else {
        return Out::Null;
    };
    let (mut low, mut high, mut total) = (first, first, PythonNumber::Int(0));
    for &value in &present {
        if value.lt(low) {
            low = value;
        }
        if high.lt(value) {
            high = value;
        }
        total = total
            .plus(value)
            .unwrap_or(PythonNumber::Float(f64::INFINITY));
    }
    let count = i128::try_from(present.len()).unwrap_or(i128::MAX);
    Out::map([
        ("min", Out::number(low)),
        ("avg", Out::Float(round(total.divided_by(count), 2))),
        ("max", Out::number(high)),
        ("n", Out::int(present.len())),
    ])
}

fn object(value: Option<&Value>) -> Option<&BTreeMap<crate::legacy_json::Text, Value>> {
    match value.map(|value| &value.0) {
        Some(Node::Object(map)) => Some(map),
        _ => None,
    }
}

/// `gpu_rollup(samples)`: additive UUID history only.
fn gpu_rollup(samples: &[&Record]) -> Vec<(&'static str, Out)> {
    let mut values: BTreeMap<String, Vec<&Value>> = BTreeMap::new();
    let mut missing = 0usize;
    for sample in samples {
        let devices = match object(sample.get("gpu"))
            .and_then(|gpu| gpu.get(&crate::legacy_json::Text(points("devices"))))
        {
            Some(Value(Node::Array(devices))) => &devices[..devices.len().min(64)],
            _ => &[],
        };
        let mut valid = Vec::new();
        for device in devices {
            let identity = text_of(super::field(device, "uuid")).map(|points| {
                points
                    .iter()
                    .filter_map(|point| char::from_u32(*point))
                    .collect::<String>()
            });
            let available = text_of(super::field(device, "identity_status"))
                == Some(points("available").as_slice());
            let util = super::field(device, "util_pct");
            let in_range = finite(util).is_some_and(|value| {
                PythonNumber::Int(0).le(value) && value.le(PythonNumber::Int(100))
            });
            if let Some(identity) = identity.filter(|identity| nvidia_uuid(identity))
                && available
                && in_range
                && let Some(util) = util
            {
                valid.push((format!("GPU-{}", identity[4..].to_ascii_lowercase()), util));
            }
        }
        let mut seen = false;
        for (identity, util) in &valid {
            if valid.iter().filter(|(other, _)| other == identity).count() == 1 {
                values.entry(identity.clone()).or_default().push(util);
                seen = true;
            }
        }
        if !seen {
            missing += 1;
        }
        if values.len() > 64 {
            return vec![
                ("gpu_devices", Out::List(Vec::new())),
                ("gpu_devices_incomplete", Out::Bool(true)),
                ("gpu_identity_missing_samples", Out::int(samples.len())),
            ];
        }
    }
    let devices = values
        .iter()
        .map(|(identity, readings)| {
            Out::map([
                ("uuid", Out::text(identity)),
                ("util_pct", agg(readings.iter().map(|value| Some(*value)))),
                ("missing_samples", Out::int(samples.len() - readings.len())),
            ])
        })
        .collect();
    vec![
        ("gpu_devices", Out::List(devices)),
        ("gpu_devices_incomplete", Out::Bool(false)),
        ("gpu_identity_missing_samples", Out::int(missing)),
    ]
}

fn within(number: Option<PythonNumber>, start: i64, length: i64) -> bool {
    number.is_some_and(|value| {
        PythonNumber::Int(i128::from(start)).le(value)
            && value.lt(PythonNumber::Int(i128::from(start) + i128::from(length)))
    })
}

fn equals(value: Option<&Value>, expected: &str) -> bool {
    text_of(value) == Some(points(expected).as_slice())
}

/// `run_bytes(r)`: (dry would-delete estimate, live deleted bytes).
fn run_bytes(run: &Record) -> (PythonNumber, PythonNumber) {
    let zero = PythonNumber::Int(0);
    let counted = |value: &Value| {
        finite(Some(value))
            .filter(|number| zero.le(*number))
            .unwrap_or(zero)
    };
    // r.get(key, raw) with raw = r.get("deleted_or_would_bytes", 0).
    let reported = |key: &str| match run.get(key).or_else(|| run.get("deleted_or_would_bytes")) {
        Some(value) => counted(value),
        None => zero,
    };
    let dry = equals(run.get("mode"), "dry");
    let live = equals(run.get("mode"), "live");
    (
        if dry {
            reported("would_delete_bytes")
        } else {
            zero
        },
        if live {
            reported("deleted_bytes")
        } else {
            zero
        },
    )
}

fn sum(values: impl Iterator<Item = PythonNumber>) -> Out {
    Out::number(values.fold(PythonNumber::Int(0), |total, value| {
        total
            .plus(value)
            .unwrap_or(PythonNumber::Float(f64::INFINITY))
    }))
}

/// The `drives` aggregate of one period: each drive with a finite `used_pct`.
fn drive_rollups(win: &[&Record]) -> BTreeMap<Vec<u32>, Out> {
    let mut names = BTreeSet::new();
    for sample in win {
        if let Some(drives) = object(sample.get("drives")) {
            names.extend(drives.keys().map(|key| key.0.clone()));
        }
    }
    let mut drives = BTreeMap::new();
    for name in names {
        let rows = win
            .iter()
            .filter_map(|sample| {
                object(sample.get("drives"))?.get(&crate::legacy_json::Text(name.clone()))
            })
            .filter(|row| finite(super::field(row, "used_pct")).is_some())
            .collect::<Vec<_>>();
        let Some(last) = rows.last() else {
            continue;
        };
        let free_min = rows
            .iter()
            .map(|row| number(super::field(row, "free")).unwrap_or(PythonNumber::Int(0)))
            .reduce(|low, value| if value.lt(low) { value } else { low });
        drives.insert(
            name,
            Out::map([
                (
                    "used_pct",
                    agg(rows.iter().map(|row| super::field(row, "used_pct"))),
                ),
                (
                    "free_last",
                    super::field(last, "free").map_or(Out::Null, super::copy),
                ),
                ("free_min", free_min.map_or(Out::Null, Out::number)),
            ]),
        );
    }
    drives
}

/// The prune counts and bytes of one period, or nulls when unavailable.
fn prune_fields(record: &mut Out, periodic: &[&Record], prune_ok: bool) {
    if !prune_ok {
        record.set("prune_unavailable", Out::Bool(true));
        for key in [
            "prune_runs_dry",
            "prune_runs_live",
            "prune_runs_partial",
            "prune_runs_failed",
            "prune_bytes_by_mode",
            "prune_bytes",
        ] {
            record.set(key, Out::Null);
        }
        return;
    }
    let count = |key: &str, value: &str| {
        Out::int(
            periodic
                .iter()
                .filter(|run| equals(run.get(key), value))
                .count(),
        )
    };
    record.set("prune_runs_dry", count("mode", "dry"));
    record.set("prune_runs_live", count("mode", "live"));
    record.set("prune_runs_partial", count("status", "partial"));
    record.set("prune_runs_failed", count("status", "failed"));
    let bytes = periodic
        .iter()
        .map(|run| run_bytes(run))
        .collect::<Vec<_>>();
    record.set(
        "prune_bytes_by_mode",
        Out::map([
            ("dry_would_delete", sum(bytes.iter().map(|pair| pair.0))),
            ("live_deleted", sum(bytes.iter().map(|pair| pair.1))),
        ]),
    );
    record.set("prune_bytes", sum(bytes.iter().map(|pair| pair.1)));
}

/// `rollup(samples, start, length, kind, runs, prune_ok)`, or `None` for an
/// empty period. `runs` of `None` derives prune records from the samples.
pub fn rollup(
    samples: &[&Record],
    window: Window,
    start: i64,
    runs: Option<&[Record]>,
    prune_ok: bool,
) -> Option<Out> {
    let length = window.length();
    let win = samples
        .iter()
        .filter(|sample| within(sample.finite("t"), start, length))
        .copied()
        .collect::<Vec<_>>();
    if win.is_empty() {
        return None;
    }
    let drives = drive_rollups(&win);
    let derived;
    let runs = match runs {
        Some(runs) => runs.iter().collect::<Vec<_>>(),
        None => {
            derived = win
                .iter()
                .flat_map(|sample| prune_records(sample))
                .collect::<Vec<_>>();
            derived.iter().collect()
        }
    };
    let periodic = runs
        .into_iter()
        .filter(|run| within(run.finite("committed_t"), start, length))
        .collect::<Vec<_>>();
    let mut record = Out::map([
        ("v", Out::int(2)),
        ("kind", Out::text(window.kind())),
        ("start", Out::int(start)),
        ("end", Out::int(start + length)),
        ("samples", Out::int(win.len())),
        (
            "cpu_pct",
            agg(win.iter().map(|sample| sample.get("cpu_pct"))),
        ),
        (
            "mem_pct",
            agg(win.iter().map(|sample| sample.get("mem_pct"))),
        ),
        (
            "gpu_pct",
            agg(win.iter().map(|sample| sample.get("gpu_pct"))),
        ),
        ("drives", Out::Map(drives)),
    ]);
    for (key, value) in gpu_rollup(&win) {
        record.set(key, value);
    }
    prune_fields(&mut record, &periodic, prune_ok);
    Some(record)
}

/// `{**r, "committed_t": s["t"]}` for each prune record of a sample.
fn prune_records(sample: &Record) -> Vec<Record> {
    let t = sample.get("t").map(super::copy);
    let Some(Value(Node::Array(records))) = sample.get("prune") else {
        return Vec::new();
    };
    records
        .iter()
        .filter(|record| matches!(record.0, Node::Object(_)))
        .filter_map(|record| {
            let mut out = super::copy(record);
            out.set("committed_t", t.clone().unwrap_or(Out::Null));
            let text = super::dump(&out)?;
            crate::legacy_json::decode_text(&text).ok().map(Record)
        })
        .collect()
}

/// An hourly or daily rollup period.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Window {
    Hour,
    Day,
}

impl Window {
    pub fn length(self) -> i64 {
        match self {
            Self::Hour => 3600,
            Self::Day => 86400,
        }
    }
    fn kind(self) -> &'static str {
        match self {
            Self::Hour => "hour",
            Self::Day => "day",
        }
    }
    /// The state cursor key.
    pub fn key(self) -> &'static str {
        match self {
            Self::Hour => "last_hour",
            Self::Day => "last_day",
        }
    }
    /// `time.strftime(name, time.gmtime(t))` of the period's rollup file.
    pub fn file(self, t: i64) -> String {
        let (year, month, _) = civil(t);
        match self {
            Self::Hour => format!("rollup-hour-{year:04}-{month:02}.jsonl"),
            Self::Day => format!("rollup-day-{year:04}.jsonl"),
        }
    }
}

/// `day_file(out, t)`: the UTC day's sample file name.
pub fn day_file(t: i64) -> String {
    let (year, month, day) = civil(t);
    format!("samples-{year:04}-{month:02}-{day:02}.jsonl")
}

/// UTC (year, month, day) of a Unix time.
fn civil(t: i64) -> (i64, i64, i64) {
    let days = t.div_euclid(86400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// Days since the epoch of a proleptic Gregorian date (any month length).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let yoe = year - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `calendar.timegm((year, month, day))`, which only requires a real first
/// day of the month (the day itself may overflow it); `None` where Python
/// raises.
fn timegm(year: i64, month: i64, day: i64) -> Option<i64> {
    ((1..=9999).contains(&year) && (1..=12).contains(&month))
        .then(|| (days_from_civil(year, month, 1) + day - 1) * 86400)
}

fn digits(text: &str, width: usize) -> Option<i64> {
    (text.len() == width && text.bytes().all(|byte| byte.is_ascii_digit()))
        .then(|| text.parse().ok())
        .flatten()
}

/// Python's `calendar.timegm` raised: a month or year outside its range.
#[derive(Debug, Eq, PartialEq)]
pub struct CalendarError;

/// The retention of one directory entry name: `Some((end, rollup))` for an
/// own history file, `None` for any other name, and `Err` where Python's
/// calendar arithmetic raises.
pub fn retention_end(name: &str) -> Result<Option<(i64, bool)>, CalendarError> {
    // `$` also matches before one final newline.
    let name = name.strip_suffix('\n').unwrap_or(name);
    let Some(stem) = name.strip_suffix(".jsonl") else {
        return Ok(None);
    };
    if let Some(date) = stem.strip_prefix("samples-") {
        let parts = date.split('-').collect::<Vec<_>>();
        if let [year, month, day] = parts[..]
            && let (Some(year), Some(month), Some(day)) =
                (digits(year, 4), digits(month, 2), digits(day, 2))
        {
            return timegm(year, month, day)
                .map(|end| Some((end + 86400, false)))
                .ok_or(CalendarError);
        }
        return Ok(None);
    }
    let (year, month) = if let Some(rest) = stem.strip_prefix("rollup-hour-") {
        match rest.split_once('-') {
            Some((year, month)) => match (digits(year, 4), digits(month, 2)) {
                (Some(year), Some(month)) => (year, month),
                _ => return Ok(None),
            },
            None => return Ok(None),
        }
    } else if let Some(year) = stem
        .strip_prefix("rollup-day-")
        .and_then(|year| digits(year, 4))
    {
        (year, 12)
    } else {
        return Ok(None);
    };
    timegm(year + month / 12, month % 12 + 1, 1)
        .map(|end| Some((end, true)))
        .ok_or(CalendarError)
}

/// The history files a roll reads and appends.
pub trait RollFiles {
    /// `read_lines(path, cfg)`: the records of one file in the output dir.
    fn records(&mut self, name: &str) -> Vec<Record>;
    /// The sample file names of the output directory.
    fn sample_names(&mut self) -> Vec<String>;
    /// `append_line(path, record)`.
    fn append(&mut self, name: &str, line: &str);
}

/// One run's roll over its day-file cache.
pub struct Roller<'a, F: RollFiles> {
    files: &'a mut F,
    days: BTreeMap<String, std::rc::Rc<Vec<Record>>>,
}

fn maximum(values: impl Iterator<Item = PythonNumber>) -> Option<PythonNumber> {
    values.reduce(|high, value| {
        if high.compare(value) == Some(Ordering::Less) {
            value
        } else {
            high
        }
    })
}

fn int_of(value: PythonNumber) -> Option<i64> {
    super::truncate(value)
}

impl<'a, F: RollFiles> Roller<'a, F> {
    pub fn new(files: &'a mut F) -> Self {
        Self {
            files,
            days: BTreeMap::new(),
        }
    }

    fn day(&mut self, name: &str) -> std::rc::Rc<Vec<Record>> {
        if let Some(records) = self.days.get(name) {
            return records.clone();
        }
        let records = std::rc::Rc::new(self.files.records(name));
        self.days.insert(name.to_owned(), records.clone());
        records
    }

    /// `last_rolled(out, cfg, name, cur, length)`.
    fn last_rolled(&mut self, window: Window, cur: i64) -> i64 {
        let back = match window {
            Window::Hour => 32 * 86400,
            Window::Day => 366 * 86400,
        };
        let current = PythonNumber::Int(i128::from(cur));
        let ends = [cur, cur - back]
            .into_iter()
            .flat_map(|t| self.files.records(&window.file(t)))
            .filter_map(|record| record.finite("end"))
            .filter(|end| end.le(current))
            .collect::<Vec<_>>();
        if let Some(end) = maximum(ends.into_iter()).and_then(int_of) {
            return end;
        }
        let mut names = self.files.sample_names();
        names.sort();
        for name in names {
            let times = self
                .files
                .records(&name)
                .iter()
                .filter_map(|record| record.finite("t"))
                .collect::<Vec<_>>();
            let Some(first) = times
                .iter()
                .copied()
                .reduce(|low, value| if value.lt(low) { value } else { low })
            else {
                continue;
            };
            let floored = match first {
                PythonNumber::Int(value) => {
                    PythonNumber::Int(value - value.rem_euclid(i128::from(window.length())))
                }
                PythonNumber::Float(value) => {
                    #[allow(clippy::cast_precision_loss)]
                    let length = window.length() as f64;
                    PythonNumber::Float(value - value.rem_euclid(length))
                }
            };
            let chosen = if floored.lt(current) {
                floored
            } else {
                current
            };
            return int_of(chosen).unwrap_or(cur);
        }
        cur
    }

    /// Append one closed period unless its start is already in its file.
    /// `Err` where Python's `allow_nan=False` dump raises (a non-finite
    /// aggregate): the roll stops and nothing is checkpointed.
    fn close(
        &mut self,
        window: Window,
        start: i64,
        runs: &[Record],
        prune_ok: bool,
    ) -> Result<(), Unencodable> {
        let target = window.file(start);
        let begin = PythonNumber::Int(i128::from(start));
        let done = self
            .files
            .records(&target)
            .iter()
            .filter_map(|record| number(record.get("start")))
            .any(|value| value.compare(begin) == Some(Ordering::Equal));
        if done {
            return Ok(());
        }
        let mut names = (start..start + window.length())
            .step_by(3600)
            .map(day_file)
            .collect::<Vec<_>>();
        names.sort();
        names.dedup();
        let held = names.iter().map(|name| self.day(name)).collect::<Vec<_>>();
        let samples = held
            .iter()
            .flat_map(|records| records.iter())
            .collect::<Vec<_>>();
        if let Some(record) = rollup(&samples, window, start, Some(runs), prune_ok) {
            let line = super::dump(&record).ok_or(Unencodable)?;
            self.files.append(&target, &line);
        }
        Ok(())
    }

    /// `roll`: close every complete period since the cursor; returns the new
    /// cursor. A period is appended only if its start is not in the file.
    /// Stops at the first period that cannot be encoded.
    pub fn roll(
        &mut self,
        window: Window,
        state: &super::State,
        now: i64,
        runs: &[Record],
        prune_ok: bool,
    ) -> Result<i64, Unencodable> {
        let length = window.length();
        let cur = now - now.rem_euclid(length);
        let current = PythonNumber::Int(i128::from(cur));
        let usable = state.cursor(window).filter(|start| {
            start.is_finite()
                && start.le(current)
                && !start.lt(PythonNumber::Int(i128::from(cur) - 400 * 86400))
        });
        let mut start = match usable.and_then(int_of) {
            Some(start) => start,
            None => self.last_rolled(window, cur),
        };
        while start + length <= cur {
            self.close(window, start, runs, prune_ok)?;
            start += length;
        }
        Ok(start)
    }
}

/// `SAMPLE_RE.match(name)`: `samples-YYYY-MM-DD.jsonl`, any digits.
pub fn sample_name(name: &str) -> bool {
    let name = name.strip_suffix('\n').unwrap_or(name);
    name.strip_prefix("samples-")
        .and_then(|rest| rest.strip_suffix(".jsonl"))
        .is_some_and(|date| {
            let parts = date.split('-').collect::<Vec<_>>();
            matches!(parts[..], [year, month, day] if digits(year, 4).is_some() && digits(month, 2).is_some() && digits(day, 2).is_some())
        })
}

/// A closed period whose record cannot be written as strict JSON.
#[derive(Debug, Eq, PartialEq)]
pub struct Unencodable;
