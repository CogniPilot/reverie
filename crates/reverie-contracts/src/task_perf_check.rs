//! Fixed guest perf result DATA. Parsing this result grants neither admission
//! nor readiness: the host must join its actual same-incarnation execution.
use reverie_core::operations::JournalId;
use serde::{Deserialize, Serialize};
use std::fmt;

pub const MAX_RESULT_BYTES: usize = 4096;
pub const CHECKER: &str = "/opt/reverie/perf/bin/reverie-perf-check";
pub const PERF: &str = "/opt/reverie/perf/bin/perf";
const EVENT: &str = "task-clock:u";

#[derive(Debug)]
pub struct PerfCheckDataError;
impl fmt::Display for PerfCheckDataError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("TASK_PERF_CHECK_RESULT_INVALID")
    }
}
impl std::error::Error for PerfCheckDataError {}
type Result<T> = std::result::Result<T, PerfCheckDataError>;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Wire {
    version: u8,
    nonce: String,
    policy: String,
    event: String,
    uid: u32,
    task_clock_milliseconds: f64,
    samples: u64,
    perf_event_paranoid: i32,
}

pub struct PerfCheckData {
    nonce: JournalId,
    wire: Wire,
}
impl PerfCheckData {
    pub fn from_perf(
        nonce: JournalId,
        uid: u32,
        perf_event_paranoid: i32,
        stat: &str,
        report: &str,
    ) -> Result<Self> {
        Self::checked(Wire {
            version: 1,
            nonce: nonce.as_str().to_owned(),
            policy: "task-v2".to_owned(),
            event: EVENT.to_owned(),
            uid,
            task_clock_milliseconds: counter(stat)?,
            samples: samples(report)?,
            perf_event_paranoid,
        })
    }
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > MAX_RESULT_BYTES {
            return Err(PerfCheckDataError);
        }
        Self::checked(serde_json::from_slice(bytes).map_err(|_| PerfCheckDataError)?)
    }
    fn checked(wire: Wire) -> Result<Self> {
        let nonce = JournalId::parse(&wire.nonce).map_err(|_| PerfCheckDataError)?;
        if wire.version != 1
            || wire.policy != "task-v2"
            || wire.event != EVENT
            || !(1..(1 << 31)).contains(&wire.uid)
            || !wire.task_clock_milliseconds.is_finite()
            || wire.task_clock_milliseconds <= 0.0
            || wire.samples == 0
        {
            return Err(PerfCheckDataError);
        }
        Ok(Self { nonce, wire })
    }
    pub fn encode(&self) -> Result<Vec<u8>> {
        serde_json::to_vec(&self.wire).map_err(|_| PerfCheckDataError)
    }
    pub fn nonce(&self) -> &JournalId {
        &self.nonce
    }
    pub fn uid(&self) -> u32 {
        self.wire.uid
    }
}
fn counter(raw: &str) -> Result<f64> {
    if raw.len() > 65_536 {
        return Err(PerfCheckDataError);
    }
    let mut result = None;
    for line in raw.lines().filter(|line| !line.starts_with('#')) {
        let fields = line.split(',').collect::<Vec<_>>();
        if fields.get(2).is_some_and(|event| event.trim() == EVENT) {
            if result.is_some() || fields[1].trim() != "msec" {
                return Err(PerfCheckDataError);
            }
            result = Some(fields[0].trim().parse().map_err(|_| PerfCheckDataError)?);
        }
    }
    result.ok_or(PerfCheckDataError)
}
fn samples(raw: &str) -> Result<u64> {
    if raw.len() > 2 * 1024 * 1024 {
        return Err(PerfCheckDataError);
    }
    let (mut samples, mut lost) = (None, None);
    for line in raw.lines() {
        if let Some(value) = line.strip_prefix("# Samples:") {
            let (count, event) = value.split_once("of event").ok_or(PerfCheckDataError)?;
            if samples.is_some() || event.trim() != "'task-clock:u'" {
                return Err(PerfCheckDataError);
            }
            samples = Some(count.trim().parse().map_err(|_| PerfCheckDataError)?);
        }
        if let Some(value) = line.strip_prefix("# Total Lost Samples:") {
            if lost.is_some() {
                return Err(PerfCheckDataError);
            }
            lost = Some(
                value
                    .trim()
                    .parse::<u64>()
                    .map_err(|_| PerfCheckDataError)?,
            );
        }
    }
    if lost != Some(0) {
        return Err(PerfCheckDataError);
    }
    samples.ok_or(PerfCheckDataError)
}

#[cfg(test)]
mod tests;
