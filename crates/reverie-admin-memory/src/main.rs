//! Explicit recall of Hands channel evidence through the current Office session.
mod automatic;
mod capture;
mod configuration;
mod database;
mod journal;
mod office;
mod read_turn;
mod recall;
mod save;
mod turn_capture;
mod turn_context;

use clap::Parser;
use nix::{
    sys::{prctl, signal::Signal},
    unistd::{getpgrp, getpid, getppid},
};
use reverie_contracts::memory::channel::journal::JournalCommand;
use serde::{Deserialize, Serialize};
use std::{
    env,
    io::{self, Read, Write},
    process::{Command, ExitCode},
    time::{Duration, Instant},
};

const REQUEST_BOUND: usize = 32_768;
const AUTOMATIC_BOUND: usize = 50_000;
// The Office can return up to 1,000 rows of 8,000 UTF-16 units each.
const TURN_CAPTURE_BOUND: usize = 32 * 1024 * 1024;
const RESPONSE_BOUND: usize = 131_072;
const MAX_CHARS: usize = 12_000;

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
            || !(1..=MAX_CHARS as i64).contains(&self.max_chars)
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

fn worker_input(expected_parent: i32, bound: usize) -> io::Result<Vec<u8>> {
    if getpgrp() != getpid() || getppid().as_raw() != expected_parent || expected_parent <= 0 {
        return Err(refused());
    }
    prctl::set_pdeathsig(Signal::SIGKILL)?;
    if getppid().as_raw() != expected_parent {
        return Err(refused());
    }
    let mut bytes = Vec::new();
    io::stdin()
        .take((bound + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > bound {
        return Err(refused());
    }
    Ok(bytes)
}

fn worker(expected_parent: i32) -> io::Result<()> {
    let request: Request = serde_json::from_slice(&worker_input(expected_parent, REQUEST_BOUND)?)?;
    request.validate()?;
    let result = recall::execute(&request)?;
    write_reply(&result, RESPONSE_BOUND)
}

fn automatic_worker(expected_parent: i32) -> io::Result<()> {
    let reply = automatic::execute(&worker_input(expected_parent, AUTOMATIC_BOUND)?)?;
    write_reply(&reply, AUTOMATIC_BOUND)
}

fn journal_command_worker(expected_parent: i32) -> io::Result<()> {
    let arguments = worker_input(expected_parent, AUTOMATIC_BOUND)?;
    write_reply(&JournalCommand::decode(&arguments), AUTOMATIC_BOUND)
}

fn journal_capture_worker(expected_parent: i32) -> io::Result<()> {
    let request = worker_input(expected_parent, TURN_CAPTURE_BOUND)?;
    write_reply(&turn_capture::execute(&request)?, AUTOMATIC_BOUND)
}

fn journal_context_worker(expected_parent: i32) -> io::Result<()> {
    let request = worker_input(expected_parent, AUTOMATIC_BOUND)?;
    write_reply(&turn_context::execute(&request)?, AUTOMATIC_BOUND)
}

fn journal_read_worker(expected_parent: i32) -> io::Result<()> {
    let request = worker_input(expected_parent, RESPONSE_BOUND)?;
    write_reply(&read_turn::execute(&request)?, RESPONSE_BOUND)
}

fn journal_save_worker(expected_parent: i32) -> io::Result<()> {
    let arguments = worker_input(expected_parent, AUTOMATIC_BOUND)?;
    write_reply(&save::execute(&arguments)?, AUTOMATIC_BOUND)
}

fn write_reply(result: &impl Serialize, bound: usize) -> io::Result<()> {
    let output = serde_json::to_vec(result)?;
    if output.len() >= bound {
        return Err(refused());
    }
    let stdout = io::stdout();
    let mut stdout = stdout.lock();
    stdout.write_all(&output)?;
    stdout.write_all(b"\n")
}

type Worker = fn(i32) -> io::Result<()>;

fn worker_argument(value: &std::ffi::OsStr) -> Option<(Worker, i32)> {
    let (option, pid) = value.to_str()?.split_once('=')?;
    let worker = match option {
        "--recall-worker" => worker,
        "--automatic-worker" => automatic_worker,
        "--journal-command-worker" => journal_command_worker,
        "--journal-save-worker" => journal_save_worker,
        "--journal-read-worker" => journal_read_worker,
        "--journal-capture-worker" => journal_capture_worker,
        "--journal-context-worker" => journal_context_worker,
        _ => return None,
    };
    Some((worker, pid.parse().ok()?))
}

fn main() -> ExitCode {
    let mut args = env::args_os().skip(1);
    if let Some((worker, pid)) = args.next().as_deref().and_then(worker_argument) {
        return if args.next().is_none() && worker(pid).is_ok() {
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
