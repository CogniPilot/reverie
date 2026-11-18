//! Normalize an authorized console response and persist its quota metadata.
use reverie_core::plan_quota::{Limits, Reading, Refusal, WindowName, WindowReading, assess};
use reverie_store::cycle_plan::{Sample, record};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::{io, path::PathBuf};

const BOUND: usize = 4 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    ledger: PathBuf,
    accounts: Vec<Value>,
    now: f64,
    reserve_percent: f64,
    max_age_seconds: f64,
}

pub(super) fn run(parent: i32) -> io::Result<()> {
    let input = crate::worker_input(parent, BOUND)?;
    let request = serde_json::from_slice::<Request>(&input)?;
    let (output, samples) = normalize(&request)?;
    let output = json!({ "plans": output });
    if serde_json::to_vec(&output)?.len() >= BOUND {
        return Err(crate::refused());
    }
    record(&request.ledger, request.now, &samples).map_err(|_| crate::refused())?;
    crate::write_reply(&output, BOUND)
}

fn normalize(request: &Request) -> io::Result<(Map<String, Value>, Vec<Sample>)> {
    let limits = Limits {
        now: request.now,
        reserve_percent: request.reserve_percent,
        max_age_seconds: request.max_age_seconds,
    };
    let mut available = Map::new();
    let mut samples = Vec::new();
    for reading in &request.accounts {
        let profile = reading["id"].as_str().ok_or_else(crate::refused)?;
        let sample = capacity(reading, profile, &limits)?;
        samples.push(Sample {
            profile: profile.to_owned(),
            body: serde_json::to_string(&sample)?,
        });
        available.insert(profile.to_owned(), sample);
    }
    Ok((available, samples))
}

fn capacity(reading: &Value, profile: &str, limits: &Limits) -> io::Result<Value> {
    let input = Reading {
        ready: reading["status"].as_str() == Some("ready"),
        updated_ms: reading["updatedAt"].as_f64(),
        windows: reading["usage"]
            .as_object()
            .map(|usage| WindowName::ORDERED.map(|name| window(usage.get(name.key())))),
    };
    let assessment = assess(input, limits);
    let windows: Vec<_> = assessment.windows.iter().map(|item| {
        json!({"name": item.name.key(), "used_percent": item.used_percent, "reset_at": item.reset_at})
    }).collect();
    let available = assessment.available();
    match assessment.result {
        Ok(result) => Ok(json!({
            "profile": profile, "available": available, "windows": windows,
            "reason": if available { "available" } else { "plan reserve or quota reached" },
            "next_reset": result.next_reset, "retry_at": result.retry_at,
        })),
        Err(Refusal::MalformedWindow) => Err(crate::refused()),
        Err(reason) => Ok(json!({
            "profile": profile, "available": false, "windows": windows, "reason": refusal(reason),
        })),
    }
}

fn refusal(reason: Refusal) -> &'static str {
    match reason {
        Refusal::Unavailable | Refusal::MalformedWindow => "usage unavailable",
        Refusal::Stale => "usage reading is stale",
        Refusal::InvalidWindow => "invalid usage window",
        Refusal::ElapsedReset => "reset passed; awaiting fresh provider reading",
    }
}

fn window(value: Option<&Value>) -> WindowReading {
    match value {
        None | Some(Value::Null) => WindowReading::Absent,
        Some(value @ Value::Object(_)) => WindowReading::Fields {
            used_percent: value["usedPercentage"].as_f64(),
            reset_ms: value["resetAt"].as_f64(),
        },
        _ => WindowReading::Malformed,
    }
}
