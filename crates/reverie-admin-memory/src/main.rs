//! Explicit recall of Hands channel evidence through the current Office session.
mod automatic;
mod capture;
mod coding_task;
mod configuration;
mod context_cli;
mod cycle_plan;
mod database;
mod dream;
mod embedding_worker;
mod hands_addressing;
mod hands_attention;
mod hands_chat;
mod hands_images;
mod hands_model;
mod hands_office;
mod hands_poll;
mod hands_prompt;
mod hands_settings;
mod hands_supervisor;
mod hands_terminal;
mod hands_turn;
mod hands_web;
mod journal;
mod journal_turn;
mod legacy_memory;
mod managed_context;
mod model_completion;
mod office;
mod opencode_context;
mod opencode_install;
mod opencode_state;
mod private_directory;
mod project_memory;
mod read_turn;
mod recall;
mod reply_text;
mod save;
mod scoped_image;
mod screen_output;
mod token_meter;
mod turn_capture;
mod turn_context;
mod turn_tool;
mod worker_channel;

use clap::Parser;
use nix::{
    sys::{prctl, signal::Signal},
    unistd::{getpgrp, getpid, getppid},
};
use serde::{Deserialize, Serialize};
use std::os::unix::process::CommandExt;
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
const OPENCODE_CONTEXT_BOUND: usize = 4 * 1024 * 1024;
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

fn check_worker_parent(expected_parent: i32) -> io::Result<()> {
    if getpgrp() != getpid() || getppid().as_raw() != expected_parent || expected_parent <= 0 {
        return Err(refused());
    }
    Ok(())
}

fn bind_worker(expected_parent: i32) -> io::Result<()> {
    check_worker_parent(expected_parent)?;
    prctl::set_pdeathsig(Signal::SIGKILL)?;
    check_worker_parent(expected_parent)
}

fn worker_input(expected_parent: i32, bound: usize) -> io::Result<Vec<u8>> {
    bind_worker(expected_parent)?;
    bounded_input(bound)
}

fn bounded_input(bound: usize) -> io::Result<Vec<u8>> {
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

fn journal_tool_worker(expected_parent: i32) -> io::Result<()> {
    let request = worker_input(expected_parent, RESPONSE_BOUND)?;
    write_reply(&turn_tool::execute(&request)?, RESPONSE_BOUND)
}

fn journal_capture_worker(expected_parent: i32) -> io::Result<()> {
    let request = worker_input(expected_parent, TURN_CAPTURE_BOUND)?;
    write_reply(&turn_capture::execute(&request)?, AUTOMATIC_BOUND)
}

fn journal_context_worker(expected_parent: i32) -> io::Result<()> {
    let request = worker_input(expected_parent, RESPONSE_BOUND)?;
    write_reply(&turn_context::execute(&request)?, RESPONSE_BOUND)
}

fn opencode_context_worker(expected_parent: i32) -> io::Result<()> {
    let request = worker_input(expected_parent, OPENCODE_CONTEXT_BOUND)?;
    write_reply(&opencode_context::execute(&request), OPENCODE_CONTEXT_BOUND)
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
        "--journal-tool-worker" => journal_tool_worker,
        "--journal-save-worker" => journal_save_worker,
        "--journal-read-worker" => journal_read_worker,
        "--journal-capture-worker" => journal_capture_worker,
        "--journal-turn-worker" => journal_turn::run,
        "--journal-context-worker" => journal_context_worker,
        "--opencode-context-worker" => opencode_context_worker,
        "--opencode-install-worker" => opencode_install::worker,
        "--embedding-worker" => embedding_worker::run,
        "--hands-images-worker" => hands_images::run,
        "--hands-model-worker" => hands_model::run,
        "--hands-chat-worker" => hands_model::chat,
        "--hands-office-chat-worker" => hands_chat::run,
        "--hands-prompt-worker" => hands_prompt::run,
        "--hands-turn-worker" => hands_turn::run,
        "--hands-answer-worker" => hands_turn::run_answer,
        "--hands-poll-worker" => hands_poll::run,
        "--hands-tick-worker" => hands_poll::run_tick,
        "--cycle-plan-worker" => cycle_plan::run,
        "--model-completion-worker" => model_completion::run,
        "--legacy-memory-worker" => legacy_memory::run,
        "--project-memory-worker" => project_memory::run,
        "--dream-worker" => dream::run,
        "--reflection-worker" => opencode_state::reflection_worker,
        "--screen-output-worker" => screen_output::run,
        "--hands-model-slot-worker" => hands_model::supervise,
        "--hands-coding-worker" => coding_task::run,
        "--hands-coding-policy-worker" => coding_task::policy,
        "--hands-coding-admission-worker" => coding_task::admit,
        "--hands-coding-authorization-worker" => coding_task::authorize,
        "--hands-settings-worker" => hands_settings::run,
        "--hands-managed-context-worker" => managed_context::run,
        "--hands-trace-worker" => hands_model::trace_worker,
        "--hands-terminal-worker" => hands_terminal::run,
        "--hands-native-terminal-worker" => hands_terminal::run_detached,
        "--hands-attention-worker" => hands_attention::run,
        "--hands-office-worker" => hands_office::run,
        "--hands-web-worker" => hands_web::run,
        _ => return None,
    };
    Some((worker, pid.parse().ok()?))
}

fn guarded_exec(
    flag: &std::ffi::OsStr,
    mut args: impl Iterator<Item = std::ffi::OsString>,
) -> Option<ExitCode> {
    let pid = flag.to_str()?.strip_prefix("--hands-guard=")?;
    let Ok(parent) = pid.parse() else {
        return Some(ExitCode::FAILURE);
    };
    let Some(program) = args.next() else {
        return Some(ExitCode::FAILURE);
    };
    if !std::path::Path::new(&program).is_absolute() || bind_worker(parent).is_err() {
        return Some(ExitCode::FAILURE);
    }
    let _ = Command::new(program).args(args).exec();
    Some(ExitCode::FAILURE)
}

fn main() -> ExitCode {
    let argv = env::args_os().collect::<Vec<_>>();
    match argv
        .first()
        .and_then(|arg| std::path::Path::new(arg).file_name())
        .and_then(|name| name.to_str())
    {
        Some("reverie-context") => return context_cli::entry(),
        Some("reverie-opencode" | "reverie-opencode-bridge") => {
            return opencode_install::entry(argv);
        }
        _ => {}
    }
    let mut args = argv.into_iter().skip(1);
    let flag = args.next();
    if flag.as_deref().is_some_and(|flag| flag == "--hands-native") {
        return hands_supervisor::entry(args);
    }
    if let Some(code) = flag
        .as_deref()
        .and_then(|flag| guarded_exec(flag, &mut args))
    {
        return code;
    }
    if let Some((worker, pid)) = flag.as_deref().and_then(worker_argument) {
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
