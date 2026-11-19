//! Run the reviewed task command with bounded I/O and a minimal environment.
use super::{Config, Task};
use crate::{capture, coding_task::runner_reply, hands_office::scoped_environment, refused};
use serde_json::{Value, json};
use std::{
    env,
    io::{self, ErrorKind},
    path::Path,
    process::Command,
    time::{Duration, Instant},
};

pub(super) struct Runner {
    pub(super) request: Value,
    capture: capture::Background,
}

impl Runner {
    pub(super) fn start(
        cfg: &Config,
        job: &Task,
        mut request: Value,
        timeout: Duration,
        cap: usize,
        allowance: usize,
    ) -> io::Result<Self> {
        request["max_output_chars"] = json!(allowance);
        let command = command(cfg, job, timeout, cap)?;
        let deadline = (Instant::now() + timeout).min(job.deadline);
        let capture = capture::Background::start(
            "hands-coding-runner",
            command,
            serde_json::to_vec(&request)?,
            deadline,
            cap,
        )?;
        Ok(Self { request, capture })
    }

    pub(super) fn poll(
        &mut self,
        job_limits: &crate::coding_task::wire::Limits,
    ) -> io::Result<Option<Value>> {
        Ok(self.capture.take()?.map(|result| {
            let (stdout, stderr, reason) = match result {
                Ok(result) if result.success => (
                    String::from_utf8(result.stdout).ok(),
                    result.stderr,
                    "invalid_output",
                ),
                Ok(result) => (None, result.stderr, "runner_crash"),
                Err(error) if error.kind() == ErrorKind::TimedOut => {
                    (None, Vec::new(), "runner_timeout")
                }
                Err(error) if error.kind() == ErrorKind::FileTooLarge => {
                    (None, Vec::new(), "output_limit")
                }
                Err(_) => (None, Vec::new(), "runner_crash"),
            };
            let mut decoded = runner_reply(stdout, std::str::from_utf8(&stderr).ok(), job_limits);
            if decoded["result"].is_null() {
                decoded["result"] = failure(reason);
            }
            decoded
        }))
    }

    pub(super) fn cancel(&mut self) -> io::Result<()> {
        self.capture.cancel()
    }
}

pub(super) fn failure(reason: &str) -> Value {
    json!({"version":1,"ok":false,"output":"","error":reason,"truncated":false,"exit_code":null})
}

fn command(cfg: &Config, job: &Task, timeout: Duration, cap: usize) -> io::Result<Command> {
    let settings = &cfg.values["coding"];
    let argv: Vec<String> = serde_json::from_value(settings["runner_argv"].clone())?;
    let (program, prefix) = argv.split_first().ok_or_else(refused)?;
    let root = settings["root"].as_str().ok_or_else(refused)?;
    let mut command = Command::new(env::current_exe()?);
    command
        .arg(format!("--hands-guard={}", std::process::id()))
        .arg(program)
        .args(prefix)
        .arg("--task-dir")
        .arg(Path::new(root).join(&job.id))
        .args([
            "--timeout-s",
            &timeout.as_secs().to_string(),
            "--max-output-bytes",
            &cap.to_string(),
        ])
        .env_clear()
        .env("PATH", "/bin:/usr/bin")
        .env("LANG", "C.UTF-8");
    if settings["failure_telemetry"] == true {
        command.arg("--command-telemetry");
    }
    if settings["tasks"][&job.id]["office_access"] == true {
        let session = cfg.values["self_session_id"].as_str().ok_or_else(refused)?;
        let values = scoped_environment(session, Some(&cfg.path))?;
        for (name, value) in values.as_object().ok_or_else(refused)? {
            command.env(name, value.as_str().ok_or_else(refused)?);
        }
    }
    Ok(command)
}
