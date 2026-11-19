use super::{Active, Effect, INVALID};
use crate::{AUTOMATIC_BOUND, read_turn, save, turn_tool::Dispatch};
use serde::Deserialize;
use serde_json::{Value, json, value::to_raw_value};

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct EffectReply {
    pub(super) result: Option<Value>,
    failure: Option<save::Failure>,
    #[serde(default)]
    invalid: bool,
}

impl EffectReply {
    fn request(effect: &mut Effect<'_>, request: Value) -> Self {
        effect(request).unwrap_or(Self {
            failure: Some(save::Failure::WorkerError),
            ..Self::default()
        })
    }

    fn failure_label(&self) -> Option<&'static str> {
        match self.failure {
            Some(save::Failure::Timeout) => Some("timeout"),
            Some(save::Failure::WorkerError) => Some("worker_error"),
            None => None,
        }
    }
}

impl Active {
    pub(super) fn dispatch(&mut self, dispatch: Dispatch, effect: &mut Effect<'_>) -> Value {
        let (name, arguments) = match parse_dispatch(dispatch) {
            Some(parsed) => parsed,
            None => return invalid(),
        };
        let arguments = arguments.filter(|raw| raw.chars().count() <= AUTOMATIC_BOUND);
        if name == "journal_commit" {
            self.save(arguments, effect)
        } else {
            self.read(&name, arguments.as_deref(), effect)
        }
    }

    fn read(&mut self, name: &str, arguments: Option<&str>, effect: &mut Effect<'_>) -> Value {
        let plan = read_turn::plan_call(
            name,
            arguments,
            self.captured["end"].clone(),
            &self.expanded,
        );
        let Some(request) = plan.get("request") else {
            return plan["reply"].clone();
        };
        let Ok(operation) = serde_json::from_value(request.clone()) else {
            return invalid();
        };
        let reply = EffectReply::request(effect, request.clone());
        if reply.invalid {
            return invalid();
        }
        let failure = reply.failure_label();
        let settled = read_turn::settle(
            operation,
            reply.result.unwrap_or(Value::Null),
            self.captured.clone(),
            failure,
        );
        let Some(mut settled) = settled else {
            return invalid();
        };
        if let Some(id) = settled["expanded_id"].as_str() {
            if !self.expanded.iter().any(|previous| previous == id) {
                self.expanded.push(id.to_owned());
            }
            self.captured = settled["captured"].take();
        }
        settled["reply"].take()
    }

    fn save(&mut self, arguments: Option<String>, effect: &mut Effect<'_>) -> Value {
        let Ok(captured) = to_raw_value(&self.captured) else {
            return unavailable("journal_save_worker_unavailable");
        };
        let plan = save::prepare(&save::Preparation {
            room: self.captured["room"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
            read_only: self.read_only,
            needs_reason: self.needs_reason,
            arguments,
            captured: &captured,
        });
        match plan {
            save::Next::Reply { reply, .. } => reply,
            save::Next::Commit { key, draft } => self.commit(effect, &key, &draft, &captured),
            save::Next::Receipt => unavailable("journal_save_worker_unavailable"),
        }
    }

    fn commit(
        &mut self,
        effect: &mut Effect<'_>,
        key: &save::Key,
        draft: &serde_json::value::RawValue,
        captured: &serde_json::value::RawValue,
    ) -> Value {
        let write = EffectReply::request(
            effect,
            json!({
                "op": "journal_commit", "draft": draft, "captured": captured,
                "previous_id": self.previous_id,
            }),
        );
        let mut next = save::classify(key, write.result);
        if matches!(next, save::Next::Receipt) {
            let mut request = json!(key);
            request["op"] = json!("journal_receipt");
            let receipt = EffectReply::request(effect, request);
            next = save::recover(
                key,
                receipt.result.as_ref(),
                receipt.failure.or(write.failure),
            );
        }
        match next {
            save::Next::Reply { reply, previous_id } => {
                self.previous_id = previous_id.or(self.previous_id);
                reply
            }
            _ => json!({
                "status": "unknown", "turn_id": key.turn_id,
                "reason": "write outcome unresolved; do not retry the write",
            }),
        }
    }
}

fn parse_dispatch(dispatch: Dispatch) -> Option<(String, Option<String>)> {
    match dispatch {
        Dispatch::Raw { name, arguments } => Some((name, arguments)),
        Dispatch::Parsed(raw) => {
            let value: Value = serde_json::from_str(raw.get()).ok()?;
            let name = value["name"].as_str()?.to_owned();
            let arguments = value.get("arguments").map(|arguments| match arguments {
                Value::String(raw) => raw.clone(),
                value => value.to_string(),
            });
            Some((name, arguments))
        }
    }
}

fn invalid() -> Value {
    json!({"status": "refused", "reason": INVALID})
}

fn unavailable(reason: &str) -> Value {
    json!({"status": "unavailable", "reason": reason})
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Settings {
    config: Value,
    status_timeout_s: f64,
    command_timeout_s: f64,
    suppress: bool,
}

/// Owns the same bounded Office/SQLite worker used by the legacy memory client.
pub(super) struct NativeEffect {
    room: String,
    settings: Settings,
}

impl NativeEffect {
    pub(super) fn new(room: String, settings: Settings) -> Self {
        Self { room, settings }
    }

    pub(super) fn call(&self, request: Value) -> EffectReply {
        if self.settings.suppress {
            return EffectReply::default();
        }
        match self.execute(request) {
            Ok(result) => EffectReply {
                result: Some(result),
                ..EffectReply::default()
            },
            Err(error) => EffectReply {
                failure: Some(if error.kind() == std::io::ErrorKind::TimedOut {
                    save::Failure::Timeout
                } else {
                    save::Failure::WorkerError
                }),
                ..EffectReply::default()
            },
        }
    }

    fn execute(&self, mut request: Value) -> std::io::Result<Value> {
        let seconds = if request["op"] == "journal_status" {
            self.settings.status_timeout_s
        } else {
            self.settings.command_timeout_s
        };
        let timeout = std::time::Duration::try_from_secs_f64(seconds)
            .ok()
            .filter(|timeout| !timeout.is_zero() && timeout.as_secs_f64() <= 10.0)
            .ok_or_else(crate::refused)?;
        request["room"] = json!(self.room);
        request["config"] = self.settings.config.clone();
        let bytes = serde_json::to_vec(&request)?;
        if bytes.len() > AUTOMATIC_BOUND {
            return Err(crate::refused());
        }
        let mut command = std::process::Command::new(std::env::current_exe()?);
        command.arg(format!("--automatic-worker={}", std::process::id()));
        let reply = crate::capture::run(
            command,
            Some(&bytes),
            crate::capture::Limits::scoped(std::time::Instant::now() + timeout, AUTOMATIC_BOUND),
        )?;
        Ok(serde_json::from_slice(&reply)?)
    }
}
