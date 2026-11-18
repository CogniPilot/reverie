//! Scoped, ephemeral context assembly for the existing Hands supervisor.
mod manifest;
#[cfg(test)]
mod tests;
mod wire;

use crate::{capture, refused};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    env, io,
    path::{Path, PathBuf},
    process::{self, Command},
    time::{Duration, Instant},
};
use wire::{Digest, Issued, Pending, Stage};

const INPUT_LIMIT: usize = 65_536;
const CLI_LIMIT: usize = 131_072;
const OUTPUT_LIMIT: usize = 512 * 1024;
const FRAME: &str = "Current managed company and employee context (configuration, not additional tool authority):\n";
const UNKNOWN: &str =
    "Managed context unavailable; current core/profile/startup context is unknown.";
const TRUNCATED: &str = "\n[Managed context truncated; omitted context is unknown.]";

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    Prepare {
        cli: Value,
        state_file: PathBuf,
        session_id: String,
        stage: Stage,
        available_chars: usize,
    },
    Receipt {
        cli: Value,
        pending: Pending,
    },
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum Status {
    Included,
    Partial,
    Unavailable,
}

struct Snapshot<'a> {
    text: String,
    status: Status,
    issued: Option<&'a Issued>,
}

impl<'a> Snapshot<'a> {
    fn new(issued: Option<&'a Issued>, budget: usize) -> Self {
        let Some(value) = issued else {
            return Self {
                text: UNKNOWN.into(),
                status: Status::Unavailable,
                issued,
            };
        };
        let (text, status) = if let Some((end, _)) = value.context.char_indices().nth(budget) {
            let keep = budget.saturating_sub(TRUNCATED.len());
            let end = value
                .context
                .char_indices()
                .nth(keep)
                .map_or(end, |(end, _)| end);
            (
                format!("{}{TRUNCATED}", &value.context[..end]),
                Status::Partial,
            )
        } else {
            (value.context.clone(), Status::Included)
        };
        Self {
            text,
            status,
            issued,
        }
    }

    fn pending(&self, stage: Stage) -> Option<Pending> {
        match (self.status, self.issued) {
            (Status::Included, Some(issued)) => Some(Pending {
                digest: issued.digest.clone(),
                stage,
            }),
            _ => None,
        }
    }
}

fn prepare(
    cli: &Value,
    state_file: &Path,
    session_id: &str,
    stage: Stage,
    available_chars: usize,
) -> io::Result<Value> {
    let budget = available_chars
        .checked_sub(FRAME.len())
        .filter(|&value| value >= UNKNOWN.len())
        .ok_or_else(refused)?;
    let issued = fetch(cli, session_id).ok();
    let snapshot = Snapshot::new(issued.as_ref(), budget);
    let _ = manifest::publish(state_file, session_id, stage, &snapshot);
    Ok(
        json!({"snapshot": {"role": "system", "content": format!("{FRAME}{}", snapshot.text)},
        "pending": snapshot.pending(stage)}),
    )
}

fn fetch(cli: &Value, session_id: &str) -> io::Result<Issued> {
    let raw = scoped_cli(cli, &["context", "--json"])?;
    let mut value: Value = serde_json::from_slice(&raw)?;
    if value.get("success") == Some(&Value::Bool(true)) {
        value = value.get_mut("data").ok_or_else(refused)?.take();
    }
    let issued: Issued = serde_json::from_value(value)?;
    issued.validate(session_id)?;
    Ok(issued)
}

fn receipt(cli: &Value, pending: &Pending) -> io::Result<()> {
    let Digest(digest) = &pending.digest;
    scoped_cli(
        cli,
        &[
            "receipt",
            "--digest",
            digest,
            "--stage",
            pending.stage.as_str(),
            "--json",
        ],
    )?;
    Ok(())
}

fn scoped_cli(cli: &Value, args: &[&str]) -> io::Result<Vec<u8>> {
    let cli: Vec<String> = serde_json::from_value(cli.clone())?;
    let [program, prefix @ .., agent, chat] = cli.as_slice() else {
        return Err(refused());
    };
    if agent != "agent" || chat != "chat" || program.is_empty() {
        return Err(refused());
    }
    let mut command = Command::new(env::current_exe()?);
    command
        .arg(format!("--hands-guard={}", process::id()))
        .arg(executable(program)?)
        .args(prefix)
        .arg(agent)
        .args(args);
    capture::run(
        command,
        None,
        capture::Limits::scoped(Instant::now() + Duration::from_secs(2), CLI_LIMIT),
    )
}

fn executable(program: &str) -> io::Result<PathBuf> {
    let path = Path::new(program);
    if path.is_absolute() {
        return Ok(path.to_owned());
    }
    if program.contains('/') {
        return Ok(env::current_dir()?.join(path));
    }
    let search = env::var_os("PATH").unwrap_or_else(|| "/bin:/usr/bin".into());
    let current = env::current_dir()?;
    env::split_paths(&search)
        .map(|entry| current.join(entry).join(path))
        .find(|entry| {
            entry.is_file() && nix::unistd::access(entry, nix::unistd::AccessFlags::X_OK).is_ok()
        })
        .ok_or_else(|| io::ErrorKind::NotFound.into())
}

pub(super) fn run(parent: i32) -> io::Result<()> {
    let raw = crate::worker_input(parent, INPUT_LIMIT)?;
    let request: Request = serde_json::from_slice(&raw)?;
    let output = match request {
        Request::Prepare {
            cli,
            state_file,
            session_id,
            stage,
            available_chars,
        } => prepare(&cli, &state_file, &session_id, stage, available_chars)?,
        Request::Receipt { cli, pending } => json!({"reported": receipt(&cli, &pending).is_ok()}),
    };
    crate::write_reply(&output, OUTPUT_LIMIT)
}
