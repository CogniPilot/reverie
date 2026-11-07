//! Scheduled routines, R1: status rounds and wake-up/wind-down calls, run ON THE HOST.
//!
//! ```text
//! reverie-routines tick [--live]        one 5-minute timer tick (dry run unless --live)
//! reverie-routines check-policy         validate the host policy and exit
//! reverie-routines status [--live]      heartbeat, open episodes, today's sends (dry ledger unless --live)
//! ```
//!
//! The trust rule: everything that decides whether to act is host-held. The policy is an owner-written host file, and
//! the ledger and observations are a host SQLite file. No container command is run, no chat room is read or posted
//! to, and R1 sends no nudges: stalls are reported only. The one agent-writable input, the optional night-cycle
//! policy, is read last, non-blocking and capped, and a failure only adds a report.

pub mod console;
pub mod json;
pub mod ledger;
pub mod policy;
pub mod tick;

use jiff::Timestamp;
use std::io::Write;
use std::path::{Path, PathBuf};

const USAGE: &str = "usage: reverie-routines [-h] [--policy POLICY] [--state-dir STATE_DIR] [--live]\n                        {tick,check-policy,status}";

const HELP: &str = "\n\nScheduled routines, R1: status rounds and wake-up/wind-down calls, run ON THE HOST.

    reverie-routines tick [--live]        # one 5-minute timer tick (dry run unless --live)
    reverie-routines check-policy         # validate the host policy and exit
    reverie-routines status [--live]      # heartbeat, open episodes, today's sends (dry ledger unless --live)

positional arguments:
  {tick,check-policy,status}

options:
  -h, --help            show this help message and exit
  --policy POLICY
  --state-dir STATE_DIR
  --live                actually send; without it the tick only logs (dry run)
";

/// An OS error worded as python's OSError prints it: `[Errno 2] No such file or directory: '<path>'`.
pub fn py_os_error(error: &std::io::Error, path: &Path) -> String {
    let text = error.to_string();
    let description = text
        .rsplit_once(" (os error")
        .map_or(text.as_str(), |(d, _)| d);
    match error.raw_os_error() {
        Some(code) => format!(
            "[Errno {code}] {description}: {}",
            json::py_repr(&py_path(path))
        ),
        None => description.to_string(),
    }
}

/// `str(pathlib.Path(p))`: repeated slashes, `.` components and a trailing slash removed.
pub fn py_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    let absolute = text.starts_with('/');
    let parts: Vec<&str> = text
        .split('/')
        .filter(|p| !p.is_empty() && *p != ".")
        .collect();
    match (absolute, parts.is_empty()) {
        (true, _) => format!("/{}", parts.join("/")),
        (false, true) => ".".into(),
        (false, false) => parts.join("/"),
    }
}

/// What the command line reads from the environment.
#[derive(Clone, Debug, Default)]
pub struct Env {
    /// `Path.home()`.
    pub home: PathBuf,
    /// `REVERIE_ROOT`, when set.
    pub root: Option<String>,
    /// `REVERIE_CONSOLE_URL`, when set.
    pub console_url: Option<String>,
    /// `REVERIE_SERVICE_TOKEN`; empty counts as unset.
    pub token: Option<String>,
}

impl Env {
    pub fn from_process() -> Env {
        let var = |k: &str| std::env::var(k).ok();
        Env {
            home: var("HOME").map_or_else(|| PathBuf::from("/"), PathBuf::from),
            root: var("REVERIE_ROOT"),
            console_url: var("REVERIE_CONSOLE_URL"),
            token: var("REVERIE_SERVICE_TOKEN").filter(|t| !t.is_empty()),
        }
    }

    fn default_paths(&self) -> (PathBuf, PathBuf) {
        let root = self
            .root
            .as_ref()
            .map_or_else(|| self.home.join("reverie"), PathBuf::from);
        (
            root.join("runtime").join("config").join("routines.json"),
            root.join("runtime"),
        )
    }
}

struct Args {
    command: String,
    policy: PathBuf,
    state_dir: PathBuf,
    live: bool,
}

enum Parsed {
    Run(Args),
    Help,
    Error(String),
}

/// argparse's rules for this parser: one positional command, long options by any unique prefix, `--opt=value`.
fn parse_args(argv: &[String], env: &Env) -> Parsed {
    let (mut policy, mut state_dir) = env.default_paths();
    let (mut command, mut live, mut only_positional) = (None, false, false);
    let mut i = 0;
    while i < argv.len() {
        let arg = &argv[i];
        i += 1;
        if only_positional || !arg.starts_with('-') || arg == "-" {
            if command.is_some() {
                return Parsed::Error(format!("unrecognized arguments: {arg}"));
            }
            if !["tick", "check-policy", "status"].contains(&arg.as_str()) {
                return Parsed::Error(format!(
                    "argument command: invalid choice: {} (choose from tick, check-policy, status)",
                    json::py_repr(arg)
                ));
            }
            command = Some(arg.clone());
            continue;
        }
        if arg == "--" {
            only_positional = true;
            continue;
        }
        if arg == "-h" || (arg.len() > 2 && "--help".starts_with(arg.as_str())) {
            return Parsed::Help;
        }
        let (name, inline) = match arg.split_once('=') {
            Some((n, v)) => (n, Some(v.to_string())),
            None => (arg.as_str(), None),
        };
        let matches: Vec<&str> = ["--policy", "--state-dir", "--live"]
            .into_iter()
            .filter(|o| name.len() > 2 && o.starts_with(name))
            .collect();
        let [option] = matches.as_slice() else {
            return Parsed::Error(format!("unrecognized arguments: {arg}"));
        };
        if *option == "--live" {
            if inline.is_some() {
                return Parsed::Error(format!(
                    "argument --live: ignored explicit argument {}",
                    json::py_repr(inline.as_deref().unwrap_or(""))
                ));
            }
            live = true;
            continue;
        }
        let value = match inline {
            Some(v) => v,
            None if i < argv.len() && !argv[i].starts_with('-') => {
                i += 1;
                argv[i - 1].clone()
            }
            None => {
                let meta = if *option == "--policy" {
                    "POLICY"
                } else {
                    "STATE_DIR"
                };
                return Parsed::Error(format!("argument {option} {meta}: expected one argument"));
            }
        };
        if *option == "--policy" {
            policy = PathBuf::from(value)
        } else {
            state_dir = PathBuf::from(value)
        }
    }
    match command {
        Some(command) => Parsed::Run(Args {
            command,
            policy,
            state_dir,
            live,
        }),
        None => Parsed::Error("the following arguments are required: command".into()),
    }
}

/// The whole command line. `now` pins the clock (tests); otherwise the system clock.
pub fn run(
    argv: &[String],
    env: &Env,
    now: Option<Timestamp>,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    let args = match parse_args(argv, env) {
        Parsed::Run(args) => args,
        Parsed::Help => {
            let _ = writeln!(out, "{USAGE}{HELP}");
            return 0;
        }
        Parsed::Error(message) => {
            let _ = writeln!(err, "{USAGE}\nreverie-routines: error: {message}");
            return 2;
        }
    };
    let policy = match policy::load(&args.policy) {
        Ok(policy) => policy,
        Err(e) => {
            let _ = writeln!(err, "routines: policy refused, nothing done: {e}");
            return 2;
        }
    };
    if args.command == "check-policy" {
        let _ = writeln!(
            out,
            "routines: policy ok ({} agents, {})",
            policy.agents.len(),
            policy.timezone
        );
        return 0;
    }
    // Dry runs keep their own ledger, so going live never inherits "already sent" rows from a dry run.
    let db = args.state_dir.join(if args.live {
        "routines.sqlite"
    } else {
        "routines.dry.sqlite"
    });
    let state = match ledger::Ledger::open(&db) {
        Ok(state) => state,
        Err(e) => {
            let reason = match e {
                ledger::OpenError::Dir(text) => text,
                ledger::OpenError::Db(e) => e.to_string(),
            };
            let _ = writeln!(
                err,
                "routines: state {} unusable, nothing done: {reason}",
                py_path(&db)
            );
            return 3;
        }
    };
    let now = now.unwrap_or_else(Timestamp::now);
    if args.command == "status" {
        return status(&policy, &state, args.live, now, out, err);
    }
    tick_command(&policy, &state, &args, env, now, out, err)
}

fn status(
    policy: &policy::Policy,
    state: &ledger::Ledger,
    live: bool,
    now: Timestamp,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    let body = || -> ledger::Result<json::Json> {
        let beat = state.meta("heartbeat")?.filter(|b| !b.is_empty());
        let mut obs = Vec::new();
        for agent in &policy.agents {
            obs.push((
                agent.name.clone(),
                ledger::obs_json(state.obs(&agent.name)?),
            ));
        }
        let day = now.to_zoned(policy.zone.clone()).date().to_string();
        Ok(json::Json::Obj(vec![
            (
                "ledger".into(),
                json::Json::Str(if live { "live" } else { "dry" }.into()),
            ),
            (
                "heartbeat".into(),
                beat.and_then(|b| b.trim().parse().ok())
                    .map_or(json::Json::Null, json::Json::Float),
            ),
            ("obs".into(), json::Json::Obj(obs)),
            ("today".into(), json::Json::List(state.sends_on(&day)?)),
        ]))
    };
    match body() {
        Ok(value) => {
            let _ = writeln!(out, "{}", json::dump(&value));
            0
        }
        Err(e) => {
            let _ = writeln!(err, "routines: state error, tick stopped: {e}");
            3
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn tick_command(
    policy: &policy::Policy,
    state: &ledger::Ledger,
    args: &Args,
    env: &Env,
    now: Timestamp,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> i32 {
    let url = env
        .console_url
        .clone()
        .unwrap_or_else(|| console::DEFAULT_URL.into());
    let Some(console) = console::Console::new(&url, env.token.clone()) else {
        let _ = writeln!(err, "routines: console URL must be loopback http");
        return 2;
    };
    let reports = args.state_dir.join("routines-reports.log");
    let paused = args.state_dir.join("routines.paused").exists();
    let mut sink = |line: &str| {
        let _ = writeln!(out, "{line}");
        let _ = out.flush();
        let appended = std::fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(&reports)
            .and_then(|mut f| f.write_all(format!("{line}\n").as_bytes()));
        if appended.is_err() {
            let _ = writeln!(err, "routines: report log not writable; journal only");
        }
    };
    let result = tick::Tick::new(policy, state, &console, &mut sink, now, (args.live, paused))
        .and_then(|mut t| t.run());
    match result {
        Ok(()) => 0,
        Err(e) => {
            let _ = writeln!(err, "routines: state error, tick stopped: {e}");
            3
        }
    }
}
