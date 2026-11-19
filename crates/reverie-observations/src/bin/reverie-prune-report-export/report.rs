use chrono::{DateTime, NaiveDateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, env, io};

pub(super) fn run_id<'a>(name: &'a str, suffix: &str) -> Option<&'a str> {
    let id = name.strip_suffix(suffix)?;
    let (stamp, token) = id.split_once('-')?;
    let stamp = stamp.as_bytes();
    // A run ID is the producer's UTC stamp and an alphanumeric nonce.
    let stamp_ok = stamp.len() == 16
        && stamp[8] == b'T'
        && stamp[15] == b'Z'
        && stamp[..8]
            .iter()
            .chain(&stamp[9..15])
            .all(u8::is_ascii_digit);
    (stamp_ok && !token.is_empty() && token.bytes().all(|byte| byte.is_ascii_alphanumeric()))
        .then_some(id)
}

type Counts = BTreeMap<Decision, u64>;

#[derive(Deserialize, Serialize, Ord, PartialOrd, Eq, PartialEq)]
#[serde(try_from = "String")]
struct Decision(String);

impl TryFrom<String> for Decision {
    type Error = &'static str;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        // Only aggregate decision labels may cross the disclosure boundary.
        if value.as_bytes().first().is_some_and(u8::is_ascii_uppercase)
            && value
                .bytes()
                .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
        {
            Ok(Self(value))
        } else {
            Err("invalid cleanup decision")
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Mode {
    Dry,
    Live,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum Pass {
    HighWater,
    Checkouts,
    Retired,
}

#[derive(Deserialize, Serialize)]
struct Space {
    total: Option<u64>,
    free: Option<u64>,
    used_pct: Option<f64>,
}

#[derive(Deserialize)]
struct Summary {
    mode: Option<Mode>,
    exit: Option<i64>,
    passes: Option<Vec<Pass>>,
    deleted_or_would_bytes: Option<u64>,
    by_decision: Option<Counts>,
    by_laptop: Option<BTreeMap<String, Counts>>,
    ceiling_bytes: Option<u64>,
    ceiling_hit: Option<bool>,
    df_before: Option<Vec<Space>>,
    df_after: Option<Vec<Space>>,
}

#[derive(Serialize)]
pub(super) struct Aggregate {
    run_id: String,
    mode: Option<Mode>,
    exit: Option<i64>,
    passes: Option<Vec<Pass>>,
    started_utc: String,
    duration_s: i64,
    deleted_or_would_bytes: Option<u64>,
    count_by_decision: Counts,
    laptop_bytes_by_decision: Counts,
    laptops: usize,
    ceiling_bytes: Option<u64>,
    ceiling_hit: Option<bool>,
    disk_before: Vec<Space>,
    disk_after: Vec<Space>,
}

impl Aggregate {
    pub(super) fn decode(run_id: String, raw: &[u8], now: DateTime<Utc>) -> io::Result<Self> {
        let summary: Summary = serde_json::from_slice(raw)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid cleanup summary"))?;
        let started = run_id
            .get(..16)
            .and_then(|stamp| NaiveDateTime::parse_from_str(stamp, "%Y%m%dT%H%M%SZ").ok())
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid cleanup run date"))?
            .and_utc();
        let laptops = summary.by_laptop.unwrap_or_default();
        let count = laptops.len();
        let mut bytes_by_decision = Counts::new();
        for (decision, bytes) in laptops.into_values().flatten() {
            let total = bytes_by_decision.entry(decision).or_default();
            *total = total.checked_add(bytes).ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidData, "cleanup totals overflow")
            })?;
        }
        Ok(Self {
            run_id,
            mode: summary.mode,
            exit: summary.exit,
            passes: summary.passes,
            started_utc: utc(started),
            duration_s: (now - started).num_seconds().max(0),
            deleted_or_would_bytes: summary.deleted_or_would_bytes,
            count_by_decision: summary.by_decision.unwrap_or_default(),
            laptop_bytes_by_decision: bytes_by_decision,
            laptops: count,
            ceiling_bytes: summary.ceiling_bytes,
            ceiling_hit: summary.ceiling_hit,
            disk_before: summary.df_before.unwrap_or_default(),
            disk_after: summary.df_after.unwrap_or_default(),
        })
    }
}

fn utc(time: DateTime<Utc>) -> String {
    time.to_rfc3339_opts(SecondsFormat::Secs, true)
}

pub(super) struct Run {
    pub(super) summary: Option<Aggregate>,
    finished_utc: String,
    service_result: String,
    exit_code: String,
    exit_status: String,
}

#[derive(Serialize)]
pub(super) struct Latest<'a> {
    finished_utc: &'a str,
    service_result: &'a str,
    exit_code: &'a str,
    exit_status: &'a str,
    run_id: Option<&'a str>,
    new_summary: bool,
    summary: Option<&'a Aggregate>,
}

impl Run {
    pub(super) fn capture(now: DateTime<Utc>, summary: Option<Aggregate>) -> Self {
        Self {
            summary,
            finished_utc: utc(now),
            service_result: env::var("SERVICE_RESULT").unwrap_or_default(),
            exit_code: env::var("EXIT_CODE").unwrap_or_default(),
            exit_status: env::var("EXIT_STATUS").unwrap_or_default(),
        }
    }

    pub(super) fn run_id(&self) -> Option<&str> {
        self.summary.as_ref().map(|summary| summary.run_id.as_str())
    }

    pub(super) fn latest(&self, fresh: bool) -> Latest<'_> {
        Latest {
            finished_utc: &self.finished_utc,
            service_result: &self.service_result,
            exit_code: &self.exit_code,
            exit_status: &self.exit_status,
            run_id: self.run_id(),
            new_summary: fresh,
            summary: self.summary.as_ref().filter(|_| fresh),
        }
    }
}
