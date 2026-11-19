use super::Settings;
use crate::capture;
use serde_json::{Map, Value, json};
use std::env;
use std::io::{self, ErrorKind};
use std::process::Command;
use std::time::{Duration, Instant};

pub(super) struct Call {
    capture: capture::Background,
    epoch: u64,
}

impl Call {
    pub(super) fn start(
        settings: &Settings,
        payload: Map<String, Value>,
        timeout: Duration,
        epoch: u64,
    ) -> io::Result<Self> {
        let deadline = Instant::now()
            .checked_add(timeout)
            .ok_or_else(crate::refused)?;
        let body = serde_json::to_vec(&json!({
            "api_base": settings.api_base,
            "key_env": settings.key_env,
            "timeout_s": timeout.as_secs_f64(),
            "max_response_bytes": settings.max_response_bytes,
            "payload": payload,
            "token_meter": settings.token_meter,
            "epoch": epoch,
            "events_file": settings.events_file,
        }))?;
        let mut command = Command::new(env::current_exe()?);
        command
            .arg(format!("--hands-model-worker={}", std::process::id()))
            .env_clear()
            .env("PATH", "/bin:/usr/bin")
            .env("LANG", "C.UTF-8");
        if let Some(name) = &settings.key_env
            && let Some(key) = env::var_os(name)
        {
            command.env(name, key);
        }
        let capture = capture::Background::start(
            "hands-model-call",
            command,
            body,
            deadline,
            settings.max_response_bytes,
        )?;
        Ok(Self { capture, epoch })
    }

    pub(super) fn take_answer(&mut self) -> io::Result<Option<Value>> {
        Ok(self
            .capture
            .take()?
            .map(|output| capture_answer(output, self.epoch)))
    }

    pub(super) fn cancel(mut self) -> io::Result<()> {
        self.capture.cancel()
    }
}

fn capture_answer(output: io::Result<capture::Completed>, epoch: u64) -> Value {
    match output {
        Ok(output) if output.success => decode(&output.stdout, epoch),
        Err(error) if error.kind() == ErrorKind::TimedOut => failure("timeout"),
        Err(error) if error.kind() == ErrorKind::FileTooLarge => failure("output_limit"),
        Err(error) if error.kind() == ErrorKind::InvalidData => failure("diagnostics_limit"),
        _ => failure("process_failed"),
    }
}

fn decode(raw: &[u8], epoch: u64) -> Value {
    match serde_json::from_slice::<Value>(raw) {
        Ok(reply) if reply.get("ok").and_then(Value::as_bool).is_some() => {
            if reply.get("epoch").and_then(Value::as_u64) == Some(epoch) {
                reply
            } else {
                failure("stale_model_epoch")
            }
        }
        _ => failure("invalid_model_worker_result"),
    }
}

pub(super) fn failure(reason: &str) -> Value {
    json!({"ok": false, "error": reason})
}

#[cfg(test)]
mod tests {
    use super::{decode, failure};
    use serde_json::json;

    #[test]
    fn only_the_exact_live_epoch_can_supply_a_result() {
        let reply = json!({"ok": true, "epoch": 2, "result": {"content": "fixture"}});
        let bytes = serde_json::to_vec(&reply).unwrap();
        assert_eq!(decode(&bytes, 2), reply);
        assert_eq!(decode(&bytes, 3), failure("stale_model_epoch"));
        assert_eq!(
            decode(br#"{"ok":1,"epoch":2}"#, 2),
            failure("invalid_model_worker_result")
        );
    }
}
