use super::Settings;
use crate::capture;
use serde_json::{Map, Value, json};
use std::env;
use std::io::{self, ErrorKind};
use std::process::Command;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

pub(super) struct Call {
    cancelled: Arc<AtomicBool>,
    handle: Option<JoinHandle<io::Result<Value>>>,
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
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancel = Arc::clone(&cancelled);
        let bound = settings.max_response_bytes;
        let handle = thread::Builder::new()
            .name("hands-model-call".into())
            .spawn(move || {
                let output = capture::supervised(
                    command,
                    Some(&body),
                    capture::Limits::cancellable(deadline, bound, &cancel),
                )?;
                Ok(capture_answer(output, epoch))
            })?;
        Ok(Self {
            cancelled,
            handle: Some(handle),
        })
    }

    pub(super) fn take_answer(&mut self) -> io::Result<Option<Value>> {
        if !self.handle.as_ref().is_some_and(JoinHandle::is_finished) {
            return Ok(None);
        }
        self.handle.take().map(join).transpose()
    }

    pub(super) fn cancel(mut self) -> io::Result<()> {
        self.settle()
    }

    fn settle(&mut self) -> io::Result<()> {
        self.cancelled.store(true, Ordering::Release);
        if let Some(handle) = self.handle.take() {
            join(handle)?;
        }
        Ok(())
    }
}

impl Drop for Call {
    fn drop(&mut self) {
        let _ = self.settle();
    }
}

fn join(handle: JoinHandle<io::Result<Value>>) -> io::Result<Value> {
    handle
        .join()
        .map_err(|_| io::Error::other("model capture thread failed"))?
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
