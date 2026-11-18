//! Explicit recall of Hands channel evidence through the current Office session.
mod capture;
mod configuration;
mod recall;

use clap::Parser;
use nix::{
    sys::{prctl, signal::Signal},
    unistd::{getpgrp, getpid, getppid},
};
use serde::{Deserialize, Serialize};
use std::{
    env,
    io::{self, Read, Write},
    process::{Command, ExitCode},
    time::{Duration, Instant},
};

const REQUEST_BOUND: usize = 32_768;
const RESPONSE_BOUND: usize = 131_072;
const MAX_CHARS: i64 = 12_000;

#[derive(Parser, Deserialize, Serialize)]
#[command(about = "Recall existing evidence from one current ordinary Office channel.")]
struct Request {
    /// Exact current channel name or ID.
    #[arg(long)]
    room: String,
    #[arg(long)]
    query: String,
    #[arg(long, default_value_t = 3000, allow_hyphen_values = true)]
    max_chars: i64,
}

impl Request {
    fn validate(&self) -> io::Result<()> {
        if self.query.trim().is_empty()
            || self.query.chars().count() > 4000
            || !(1..=MAX_CHARS).contains(&self.max_chars)
        {
            return Err(refused());
        }
        Ok(())
    }
    fn max_chars(&self) -> usize {
        usize::try_from(self.max_chars).expect("checked request budget")
    }
}

fn refused() -> io::Error {
    io::Error::other("channel memory unavailable")
}

fn parent(request: &Request) -> io::Result<()> {
    request.validate()?;
    let raw = serde_json::to_vec(request)?;
    if raw.len() > REQUEST_BOUND {
        return Err(refused());
    }
    let mut child = Command::new(env::current_exe()?);
    child.arg(format!("--recall-worker={}", getpid()));
    let signals = capture::Signals::install()?;
    let output = capture::run(
        child,
        Some(&raw),
        capture::Limits::worker(
            Instant::now() + Duration::from_secs(10),
            RESPONSE_BOUND,
            &signals,
        ),
    )?;
    let decoded: recall::Reply = serde_json::from_slice(&output)?;
    if decoded.text.chars().count() > request.max_chars() {
        return Err(refused());
    }
    io::stdout().lock().write_all(&output)
}

fn worker(expected_parent: i32) -> io::Result<()> {
    if getpgrp() != getpid() || getppid().as_raw() != expected_parent || expected_parent <= 0 {
        return Err(refused());
    }
    prctl::set_pdeathsig(Signal::SIGKILL)?;
    if getppid().as_raw() != expected_parent {
        return Err(refused());
    }
    let mut bytes = Vec::new();
    io::stdin()
        .take((REQUEST_BOUND + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > REQUEST_BOUND {
        return Err(refused());
    }
    let request: Request = serde_json::from_slice(&bytes)?;
    request.validate()?;
    let result = recall::execute(&request)?;
    let output = serde_json::to_vec(&result)?;
    if output.len() >= RESPONSE_BOUND {
        return Err(refused());
    }
    let stdout = io::stdout();
    let mut stdout = stdout.lock();
    stdout.write_all(&output)?;
    stdout.write_all(b"\n")
}

fn main() -> ExitCode {
    let mut args = env::args_os().skip(1);
    if let Some(pid) = args
        .next()
        .as_deref()
        .and_then(|value| value.to_str())
        .and_then(|value| value.strip_prefix("--recall-worker="))
    {
        return if args.next().is_none() && pid.parse().ok().is_some_and(|pid| worker(pid).is_ok()) {
            ExitCode::SUCCESS
        } else {
            ExitCode::FAILURE
        };
    }
    if parent(&Request::parse()).is_ok() {
        ExitCode::SUCCESS
    } else {
        eprintln!(
            r#"{{"error":"ValueError","nextStep":"Check your own harness configuration and current channel membership; see /handbook/memory."}}"#
        );
        ExitCode::FAILURE
    }
}
