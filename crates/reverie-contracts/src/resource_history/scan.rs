//! File selection and the bounded record reader of `query`.
use super::{
    HistoryRefused, HistoryRequest, HistorySource, MAX_BYTES, MAX_POINTS, MAX_ROWS,
    ObservationConfig, field, integer,
};
use crate::legacy_json::{self, Node, Number, Value, truthy};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum Kind {
    Raw,
    Hour,
    Day,
}

/// The validated query shape: bucket step and aligned origin.
pub(super) struct Plan {
    pub(super) step: i64,
    pub(super) origin: i64,
    pub(super) interval: i64,
}

fn ceil_div(numerator: i64, step: i64) -> i64 {
    (numerator + step - 1) / step
}

impl Plan {
    pub(super) fn new(
        config: &ObservationConfig,
        request: &HistoryRequest,
    ) -> Result<Self, HistoryRefused> {
        let (start, end, now) = (request.start, request.end, request.now);
        let gpu_ok = request.gpu.as_deref().is_none_or(gpu_uuid);
        let resolutions = ["auto", "minute", "five-minute", "hour", "day"];
        let accepted = 0 <= start
            && start < end
            && end <= now + 5
            && end - start <= 400 * 86400
            && resolutions.contains(&request.resolution.as_str())
            && gpu_ok;
        if !accepted {
            return Err(HistoryRefused("History query refused"));
        }
        let step = match request.resolution.as_str() {
            "minute" => 60,
            "five-minute" => 300,
            "hour" => 3600,
            "day" => 86400,
            _ => [60, 300, 3600, 86400]
                .into_iter()
                .find(|step| i128::from(ceil_div(end - start, *step)) <= MAX_POINTS)
                .unwrap_or(86400),
        };
        let origin = start - start % step;
        if i128::from(ceil_div(end - origin, step)) > MAX_POINTS {
            return Err(HistoryRefused("History point bound exceeded"));
        }
        Ok(Self {
            step,
            origin,
            interval: config.interval_seconds,
        })
    }
    fn rollup_kind(&self) -> Option<Kind> {
        match self.step {
            86400 => Some(Kind::Day),
            3600 => Some(Kind::Hour),
            _ => None,
        }
    }
}

/// `GPU-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`, lowercase hex.
pub(super) fn gpu_uuid(text: &str) -> bool {
    let groups = [8usize, 4, 4, 4, 12];
    let Some(rest) = text.strip_prefix("GPU-") else {
        return false;
    };
    let parts = rest.split('-').collect::<Vec<_>>();
    parts.len() == groups.len()
        && parts.iter().zip(groups).all(|(part, width)| {
            part.len() == width
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
}

fn days_in_month(year: i64, month: i64) -> i64 {
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if leap => 29,
        _ => 28,
    }
}

/// Days from 1970-01-01 to a proleptic Gregorian date.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let yoe = year - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn digits(text: &str, width: usize) -> Option<i64> {
    (text.len() == width && text.bytes().all(|byte| byte.is_ascii_digit()))
        .then(|| text.parse().ok())?
}

/// `FILES.fullmatch(name)` then `file_interval(name)`: UTC filename windows.
/// A matching name with an impossible date is Python's ValueError (refused).
pub(super) fn file_window(name: &str) -> Option<Result<(Kind, i64, i64), HistoryRefused>> {
    let invalid = || Some(Err(HistoryRefused("Invalid history file date")));
    let stem = name.strip_suffix(".jsonl")?;
    if let Some(date) = stem.strip_prefix("samples-") {
        let (year, month, day) = (
            digits(date.get(0..4)?, 4)?,
            digits(date.get(5..7)?, 2)?,
            digits(date.get(8..)?, 2)?,
        );
        if date.len() != 10 || &date[4..5] != "-" || &date[7..8] != "-" {
            return None;
        }
        if !(1..=9999).contains(&year)
            || !(1..=12).contains(&month)
            || !(1..=days_in_month(year, month)).contains(&day)
            || (year, month, day) == (9999, 12, 31)
        {
            // The reference's next day overflows datetime there (OverflowError).
            return invalid();
        }
        let begin = days_from_civil(year, month, day) * 86400;
        return Some(Ok((Kind::Raw, begin, begin + 86400)));
    }
    if let Some(month_text) = stem.strip_prefix("rollup-hour-") {
        let (year, month) = (
            digits(month_text.get(0..4)?, 4)?,
            digits(month_text.get(5..)?, 2)?,
        );
        if month_text.len() != 7 || &month_text[4..5] != "-" {
            return None;
        }
        if !(1..=9999).contains(&year)
            || !(1..=12).contains(&month)
            || (year == 9999 && month == 12)
        {
            return invalid();
        }
        let (next_year, next_month) = if month == 12 {
            (year + 1, 1)
        } else {
            (year, month + 1)
        };
        return Some(Ok((
            Kind::Hour,
            days_from_civil(year, month, 1) * 86400,
            days_from_civil(next_year, next_month, 1) * 86400,
        )));
    }
    let year = digits(stem.strip_prefix("rollup-day-")?, 4)?;
    if !(1..=9998).contains(&year) {
        return invalid();
    }
    Some(Ok((
        Kind::Day,
        days_from_civil(year, 1, 1) * 86400,
        days_from_civil(year + 1, 1, 1) * 86400,
    )))
}

/// One parsed record: its timestamp, whether it is a raw sample, the object.
pub(super) struct Row {
    pub(super) t: i64,
    pub(super) raw: bool,
    pub(super) value: Value,
}

/// Shared read accounting across every file (`records` in Python).
pub(super) struct Reader {
    pub(super) total: usize,
    pub(super) count: usize,
    pub(super) malformed: i128,
}

/// `bytes.splitlines()`: `\n`, `\r` and `\r\n` only.
fn lines(data: &[u8]) -> Vec<&[u8]> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut index = 0;
    while index < data.len() {
        if data[index] == b'\n' || data[index] == b'\r' {
            out.push(&data[start..index]);
            if data[index] == b'\r' && data.get(index + 1) == Some(&b'\n') {
                index += 1;
            }
            start = index + 1;
        }
        index += 1;
    }
    if start < data.len() {
        out.push(&data[start..]);
    }
    out
}

impl Reader {
    pub(super) fn records(
        &mut self,
        source: &dyn HistorySource,
        window: (Kind, i64, i64),
        data: &[u8],
        charged: Option<usize>,
        now: i64,
    ) -> Result<Vec<(i64, Value)>, HistoryRefused> {
        let expired = HistoryRefused("History read deadline exceeded");
        if source.expired() {
            return Err(expired);
        }
        self.total += charged.unwrap_or(data.len());
        if self.total > MAX_BYTES {
            return Err(HistoryRefused("History byte bound exceeded"));
        }
        let mut out = Vec::new();
        for line in lines(data) {
            self.count += 1;
            if self.count.is_multiple_of(1000) && source.expired() {
                return Err(expired);
            }
            if i128::try_from(self.count).unwrap_or(i128::MAX) > MAX_ROWS || line.len() > 262_144 {
                return Err(HistoryRefused("History row bound exceeded"));
            }
            let Some(row) = legacy_json::decode_metadata_bytes(line)
                .ok()
                .filter(|row| matches!(row.0, Node::Object(_)))
            else {
                self.malformed += 1;
                continue;
            };
            let name = if window.0 == Kind::Raw { "t" } else { "start" };
            match integer(field(&row, name)).and_then(|t| i64::try_from(t).ok()) {
                Some(t) if 0 <= t && window.1 <= t && t < window.2 && t <= now + 5 => {
                    out.push((t, row))
                }
                _ => self.malformed += 1,
            }
        }
        Ok(out)
    }
}

/// Python `value == number` for JSON data (`row.get('end') != t+step`).
fn equals(value: Option<&Value>, number: i64) -> bool {
    match value {
        Some(Value(Node::Number(Number::Integer(digits)))) => {
            digits.parse::<i128>().ok() == Some(i128::from(number))
        }
        #[allow(clippy::cast_precision_loss, clippy::float_cmp)]
        Some(Value(Node::Number(Number::Float(float)))) => {
            crate::python_number::PythonNumber::Float(*float)
                .compare(crate::python_number::PythonNumber::Int(i128::from(number)))
                == Some(std::cmp::Ordering::Equal)
        }
        Some(Value(Node::Bool(flag))) => i64::from(*flag) == number,
        _ => false,
    }
}

/// Everything read before projection.
pub(super) struct Scanned {
    pub(super) rows: Vec<Row>,
    pub(super) reader: Reader,
    pub(super) latest: Option<i64>,
    pub(super) freshness_complete: bool,
    pub(super) raw_files: usize,
}

type Selected = Vec<(String, (Kind, i64, i64))>;

fn select(source: &mut dyn HistorySource) -> Result<Selected, HistoryRefused> {
    let entries = source.entries()?;
    if entries.len() > 1024 {
        return Err(HistoryRefused("History file bound exceeded"));
    }
    let mut selected = Vec::new();
    for name in entries {
        if let Some(window) = file_window(&name) {
            selected.push((name, window?));
        }
    }
    Ok(selected)
}

pub(super) fn scan(
    source: &mut dyn HistorySource,
    plan: &Plan,
    request: &HistoryRequest,
) -> Result<Scanned, HistoryRefused> {
    let selected = select(source)?;
    let mut reader = Reader {
        total: 0,
        count: 0,
        malformed: 0,
    };
    let mut rows = Vec::new();
    let covered = rollups(source, plan, request, &selected, &mut reader, &mut rows)?;
    let scanned_raw = raws(
        source,
        plan,
        request,
        &selected,
        &mut reader,
        &mut rows,
        &covered,
    )?;
    let (latest, freshness_complete, raw_files) =
        freshness(source, request, &selected, &mut reader, &scanned_raw)?;
    Ok(Scanned {
        rows,
        reader,
        latest,
        freshness_complete,
        raw_files,
    })
}

/// Prefer one committed matching period wholly inside the requested range.
fn rollups(
    source: &mut dyn HistorySource,
    plan: &Plan,
    request: &HistoryRequest,
    selected: &Selected,
    reader: &mut Reader,
    rows: &mut Vec<Row>,
) -> Result<BTreeSet<i64>, HistoryRefused> {
    let (step, kind) = (plan.step, plan.rollup_kind());
    let mut covered = BTreeSet::new();
    let mut seen = BTreeSet::new();
    let label = if kind == Some(Kind::Day) {
        "day"
    } else {
        "hour"
    };
    for (name, window) in selected {
        if Some(window.0) != kind || window.2 <= request.start || window.1 >= request.end {
            continue;
        }
        let data = source.read(name)?;
        for (t, row) in reader.records(source, *window, &data, None, request.now)? {
            let kind_ok = matches!(field(&row, "kind"), Some(Value(Node::String(value))) if value.equals_ascii(label));
            let samples = integer(field(&row, "samples"));
            if !kind_ok
                || !equals(field(&row, "end"), t + step)
                || t % step != 0
                || !samples.is_some_and(|n| (1..=MAX_ROWS).contains(&n))
            {
                reader.malformed += 1;
                continue;
            }
            if t < request.start || t + step > request.end.min(request.now) {
                continue;
            }
            if !seen.insert(t) {
                return Err(HistoryRefused("Duplicate committed history period"));
            }
            let devices_listed = matches!(field(&row, "gpu_devices"), Some(Value(Node::Array(_))));
            if request.gpu.is_none()
                || (devices_listed && !truthy(field(&row, "gpu_devices_incomplete")))
            {
                covered.insert(t);
            }
            rows.push(Row {
                t,
                raw: false,
                value: row,
            });
        }
    }
    Ok(covered)
}

#[allow(clippy::too_many_arguments)]
fn raws(
    source: &mut dyn HistorySource,
    plan: &Plan,
    request: &HistoryRequest,
    selected: &Selected,
    reader: &mut Reader,
    rows: &mut Vec<Row>,
    covered: &BTreeSet<i64>,
) -> Result<BTreeMap<String, Option<i64>>, HistoryRefused> {
    let step = plan.step;
    let mut scanned = BTreeMap::new();
    for (name, window) in selected {
        if window.0 != Kind::Raw || window.2 <= request.start || window.1 >= request.end {
            continue;
        }
        let first = plan.origin.max(window.1);
        let last = request.end.min(window.2);
        let all_covered = (first..last)
            .step_by(usize::try_from(step).unwrap_or(1))
            .all(|t| covered.contains(&t));
        if all_covered {
            continue;
        }
        let data = source.read(name)?;
        let mut newest: Option<i64> = None;
        for (t, row) in reader.records(source, *window, &data, None, request.now)? {
            newest = Some(newest.map_or(t, |newest| newest.max(t)));
            if request.start <= t && t < request.end && !covered.contains(&(t - t % step)) {
                rows.push(Row {
                    t,
                    raw: true,
                    value: row,
                });
            }
        }
        scanned.insert(name.clone(), newest);
    }
    Ok(scanned)
}

/// Freshness is independent of the range: at most eight newest raw files.
fn freshness(
    source: &mut dyn HistorySource,
    request: &HistoryRequest,
    selected: &Selected,
    reader: &mut Reader,
    scanned: &BTreeMap<String, Option<i64>>,
) -> Result<(Option<i64>, bool, usize), HistoryRefused> {
    let mut raw = selected
        .iter()
        .filter(|(_, window)| window.0 == Kind::Raw && window.1 <= request.now + 5)
        .collect::<Vec<_>>();
    raw.sort_by(|left, right| right.0.cmp(&left.0));
    let mut complete = true;
    let mut latest = None;
    for (name, window) in raw.iter().take(8) {
        let newest = if let Some(newest) = scanned.get(name) {
            *newest
        } else {
            let tail = source.tail(name)?;
            complete &= tail.complete;
            let records =
                reader.records(source, *window, &tail.data, Some(tail.charged), request.now)?;
            records.iter().map(|(t, _)| *t).max()
        };
        if newest.is_some() {
            latest = newest;
            break;
        }
    }
    if latest.is_none() && raw.len() > 8 {
        complete = false;
    }
    Ok((latest, complete, raw.len()))
}
