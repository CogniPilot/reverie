use crate::hands_web::{self, Request};
use serde_json::{Value, json};
use std::{io, path::Path, time::Instant};

pub(super) struct Trace {
    started: Instant,
    steps: Vec<Value>,
    timing: Vec<String>,
}

impl Trace {
    pub(super) fn new() -> Self {
        Self {
            started: Instant::now(),
            steps: Vec::new(),
            timing: Vec::new(),
        }
    }

    pub(super) fn event(&mut self, event: &Value) {
        if let Some(step) = event.get("trace").filter(|_| self.steps.len() < 24) {
            self.steps.push(step.clone());
        }
        if let Some(frame) = event["timing"]
            .as_array()
            .and_then(|rows| <&[Value; 3]>::try_from(&rows[..]).ok())
            && let (Some(kind), Some(elapsed)) = (frame[0].as_str(), frame[1].as_f64())
        {
            self.timing.push(timing(kind, elapsed, &frame[2]));
        }
    }

    pub(super) fn timings(&self) -> String {
        if self.timing.is_empty() {
            "-".into()
        } else {
            self.timing.join(",")
        }
    }

    pub(super) fn finish(
        &self,
        path: Option<&Path>,
        turn: &Value,
        result: &io::Result<Value>,
    ) -> io::Result<()> {
        let Some(path) = path else {
            return Ok(());
        };
        let outcome = match result {
            Ok(result) => result["outcome"].as_str().unwrap_or("error"),
            Err(error) if error.kind() == io::ErrorKind::TimedOut => "error:TimeoutError",
            Err(error) if error.kind() == io::ErrorKind::Interrupted => "error:KeyboardInterrupt",
            Err(_) => "error:RuntimeError",
        };
        let line = json!({"at":jiff::Timestamp::now().strftime("%Y-%m-%dT%H:%M:%SZ").to_string(),
            "room":turn["room"],"msg":turn["message"]["id"],"outcome":outcome,
            "seconds":round(self.started.elapsed().as_secs_f64()),"steps":self.steps})
        .to_string();
        hands_web::execute(Request::AppendDiagnostic {
            path: path.to_owned(),
            line,
        })?;
        Ok(())
    }
}

fn round(seconds: f64) -> f64 {
    (seconds * 100.0).round() / 100.0
}

fn timing(kind: &str, elapsed: f64, details: &Value) -> String {
    let letter = if kind == "model" { 'm' } else { 's' };
    let elapsed = round(elapsed);
    let step = format!("{letter}{elapsed:?}");
    if !details.is_object() {
        return step;
    }
    let units = |key: &str| details[key].as_f64().unwrap_or_default();
    format!(
        "{step}(p{}/{:.1}s,g{}/{:.1}s)",
        units("prompt_n") as i64,
        units("prompt_ms") / 1000.0,
        units("predicted_n") as i64,
        units("predicted_ms") / 1000.0
    )
}
