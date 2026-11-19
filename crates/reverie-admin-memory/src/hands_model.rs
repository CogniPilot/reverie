//! One native model request shared by Hands chat and the coding arbiter.
mod delta;
mod slot;
mod stream;
#[cfg(test)]
mod tests;
mod trace;
pub(super) use delta::DisplayKind as TraceKind;
pub(super) use slot::supervise;
pub(super) use trace::trace_worker;
pub(super) use trace::{TraceReader, redact as redact_trace};

use crate::token_meter::{self, KeyName, Meter, Stats, credential};
use reverie_host::embeddings::model_api::{Client, Failure, Route};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::{io, num::NonZeroU64, path::PathBuf, time::Duration};
use stream::Stream;
use tokio::time::{Instant, timeout_at};
use trace::Trace;

const CODING_INPUT_LIMIT: usize = 1024 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    epoch: Option<NonZeroU64>,
    api_base: String,
    key_env: Option<KeyName>,
    timeout_s: f64,
    max_response_bytes: usize,
    payload: Map<String, Value>,
    token_meter: Option<token_meter::Settings>,
    events_file: Option<PathBuf>,
}

struct Model {
    client: Client,
    key_env: Option<KeyName>,
    timeout: Duration,
    response_limit: usize,
    meter: Option<Meter>,
    trace_path: Option<PathBuf>,
}

impl Request {
    fn configure(self) -> Result<(Model, Map<String, Value>), Failure> {
        let timeout = Duration::try_from_secs_f64(self.timeout_s).map_err(|_| Failure::Invalid)?;
        let model = Model {
            client: Client::new(self.api_base, timeout, self.max_response_bytes)?,
            key_env: self.key_env,
            timeout,
            response_limit: self.max_response_bytes,
            meter: self
                .token_meter
                .map(token_meter::Settings::configure)
                .transpose()?,
            trace_path: self.events_file,
        };
        Ok((model, self.payload))
    }
}

enum Admission {
    Unmeasured,
    Measured(Stats),
    TokenizerUnavailable,
}

impl Model {
    async fn admission(
        &self,
        payload: &Value,
        deadline: Instant,
        chat: bool,
    ) -> Result<Admission, Failure> {
        let Some(meter) = &self.meter else {
            return Ok(Admission::Unmeasured);
        };
        // Deadline expiry comes from the outer timer and never becomes optional.
        match timeout_at(deadline, meter.measure(payload)).await {
            Err(_) => Err(Failure::Timeout),
            Ok(Err(Failure::Timeout)) if chat && Instant::now() < deadline => {
                Ok(Admission::TokenizerUnavailable)
            }
            Ok(result) => result.map(Admission::Measured),
        }
    }

    async fn complete(&self, payload: Map<String, Value>, chat: bool) -> Result<Value, Failure> {
        let deadline = Instant::now()
            .checked_add(self.timeout)
            .ok_or(Failure::Invalid)?;
        let payload = Value::Object(payload);
        let admission = self.admission(&payload, deadline, chat).await?;
        if Instant::now() >= deadline {
            return Err(Failure::Timeout);
        }
        if let Admission::Measured(stats) = &admission
            && !stats.admitted
        {
            return Ok(json!({"_context_overflow": true, "_context_stats": stats}));
        }
        let Value::Object(payload) = payload else {
            return Err(Failure::Invalid);
        };
        let key = credential(self.key_env.as_ref())?;
        let mut trace = Trace::new(self.trace_path.as_deref(), key.as_deref())?;
        if Instant::now() >= deadline {
            return Err(Failure::Timeout);
        }
        let outcome =
            timeout_at(deadline, self.response(payload, key.as_deref(), &mut trace)).await;
        trace.flush()?;
        let mut result = message(outcome.map_err(|_| Failure::Timeout)??)?;
        match admission {
            Admission::Measured(stats) => {
                result.insert("_context_stats".into(), json!(stats));
            }
            Admission::TokenizerUnavailable => {
                result.insert("_token_meter_status".into(), json!("unavailable"));
            }
            Admission::Unmeasured => {}
        }
        Ok(Value::Object(result))
    }

    async fn response(
        &self,
        mut payload: Map<String, Value>,
        key: Option<&str>,
        trace: &mut Trace,
    ) -> Result<Value, Failure> {
        if self.trace_path.is_some() {
            stream_request(&mut payload)?;
            let data = serde_json::to_vec(&payload).map_err(|_| Failure::Invalid)?;
            let mut stream = Stream::new(self.response_limit);
            self.client
                .stream(data, key, |data| stream.feed(data, trace))
                .await?;
            return stream.finish(trace);
        }
        let data = serde_json::to_vec(&payload).map_err(|_| Failure::Invalid)?;
        let bytes = self
            .client
            .request(Route::Completions, Some(data), key)
            .await?;
        serde_json::from_slice(&bytes).map_err(|_| Failure::Invalid)
    }
}

fn stream_request(payload: &mut Map<String, Value>) -> Result<(), Failure> {
    let mut options = match payload.remove("stream_options") {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(options)) => options,
        _ => return Err(Failure::Invalid),
    };
    payload.insert("stream".into(), Value::Bool(true));
    options.insert("include_usage".into(), Value::Bool(true));
    payload.insert("stream_options".into(), Value::Object(options));
    Ok(())
}

fn message(response: Value) -> Result<Map<String, Value>, Failure> {
    let choice = response
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .ok_or(Failure::Invalid)?;
    let mut result = choice
        .get("message")
        .and_then(Value::as_object)
        .cloned()
        .ok_or(Failure::Invalid)?;
    result.insert(
        "_finish_reason".into(),
        choice.get("finish_reason").cloned().unwrap_or(Value::Null),
    );
    for (key, destination) in [("timings", "_timings"), ("usage", "_usage")] {
        if let Some(value) = response.get(key).filter(|value| value.is_object()) {
            result.insert(destination.into(), value.clone());
        }
    }
    if let Some(model) = response.get("model").filter(|value| value.is_string()) {
        result.insert("_model".into(), model.clone());
    }
    Ok(result)
}

fn serve(request: Request, chat: bool) -> Value {
    let epoch = request.epoch;
    let result = request.configure().and_then(|(model, payload)| {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|_| Failure::Invalid)?;
        let result = runtime.block_on(model.complete(payload, chat));
        runtime.shutdown_background();
        result
    });
    match result {
        Ok(result) => json!({"ok": true, "epoch": epoch, "result": result}),
        Err(Failure::Timeout) => json!({"ok": false, "epoch": epoch, "error": "model_timeout"}),
        Err(Failure::Http(code)) if chat => {
            json!({"ok": false, "epoch": epoch, "error": "model_request_failed", "http_status": code})
        }
        Err(_) => json!({"ok": false, "epoch": epoch, "error": "model_request_failed"}),
    }
}

pub(super) fn run(parent: i32) -> io::Result<()> {
    let input = crate::worker_input(parent, CODING_INPUT_LIMIT)?;
    let request = serde_json::from_slice::<Request>(&input)
        .ok()
        .filter(|request| request.epoch.is_some());
    let result = request.map_or_else(
        || json!({"ok": false, "error": "invalid_model_worker_input"}),
        |request| serve(request, false),
    );
    write_result(&result)
}

pub(super) fn chat(parent: i32) -> io::Result<()> {
    crate::bind_worker(parent)?;
    let request: Request = serde_json::from_reader(io::BufReader::new(io::stdin().lock()))?;
    write_result(&serve(request, true))
}

fn write_result(result: &Value) -> io::Result<()> {
    use std::io::Write;
    let mut output = io::stdout().lock();
    serde_json::to_writer(&mut output, result)?;
    output.write_all(b"\n")
}
