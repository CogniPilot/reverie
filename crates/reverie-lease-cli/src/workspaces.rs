//! Command-line entry point for owned, leased task workspaces.
use clap::{Parser, Subcommand};
use nix::sys::signal::Signal;
use reverie_host::{
    lease::{LeaseBase, Signals, end_by},
    task_workspace::{Result, RunOutcome, TaskWorkspaces},
};
use serde_json::json;
use std::{
    ffi::OsString,
    io::{self, Write},
    path::PathBuf,
    process::{Command, ExitCode},
};

/// Run tasks in leased disposable workspaces and clean them after a saved handoff.
#[derive(Parser)]
struct Cli {
    /// Workspace registry root. Defaults to REVERIE_TASKS_ROOT or /tmp/reverie/tasks.
    #[arg(long)]
    root: Option<PathBuf>,
    #[command(subcommand)]
    action: Action,
}

#[derive(Subcommand)]
enum Action {
    /// Allocate a workspace and print its path.
    Create { name: String },
    /// Run a command with its scratch and build directories in the workspace.
    Run {
        name: String,
        #[arg(required = true, trailing_var_arg = true, allow_hyphen_values = true)]
        command: Vec<OsString>,
    },
    /// Record the handoff for a stopped workspace and release its reservation.
    Finish {
        name: String,
        #[arg(long)]
        handoff: String,
    },
    /// Check a completed workspace, or delete it under the janitor lock.
    Clean {
        name: String,
        #[arg(long)]
        apply: bool,
    },
    /// Protect unfinished workspaces for another 24 hours.
    RenewAll,
}

fn root(selected: Option<PathBuf>) -> PathBuf {
    let root = selected
        .or_else(|| std::env::var_os("REVERIE_TASKS_ROOT").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("/tmp/reverie/tasks"));
    match (root.strip_prefix("~"), std::env::home_dir()) {
        (Ok(rest), Some(home)) => home.join(rest),
        _ => root,
    }
}

fn run(
    workspaces: &TaskWorkspaces,
    base: &LeaseBase,
    name: &str,
    args: &[OsString],
) -> Result<i32> {
    let signals = Signals::take(&[Signal::SIGTERM, Signal::SIGINT, Signal::SIGHUP])?;
    let mut command = Command::new(&args[0]);
    command.args(&args[1..]);
    match workspaces.run(base, name, &mut command, &signals)? {
        RunOutcome::Exited(code) => Ok(code),
        RunOutcome::InterruptedBeforeLaunch(signal) => end_by(signal),
        RunOutcome::CleanupUnknown => Ok(124),
    }
}

fn dispatch(cli: Cli) -> Result<i32> {
    let workspaces = TaskWorkspaces::open(&root(cli.root))?;
    let base = LeaseBase::current_user()?;
    match cli.action {
        Action::Create { name } => {
            let path = workspaces.create(&base, &name)?;
            let mut output = io::stdout().lock();
            output.write_all(path.as_os_str().as_encoded_bytes())?;
            writeln!(output)?;
        }
        Action::Run { name, command } => return run(&workspaces, &base, &name, &command),
        Action::Finish { name, handoff } => workspaces.finish(&base, &name, &handoff)?,
        Action::Clean { name, apply } => {
            workspaces.clean(&base, &name, apply)?;
            writeln!(
                io::stdout(),
                "{}",
                json!({"workspace": name, "removed": apply})
            )?;
        }
        Action::RenewAll => {
            let report =
                serde_json::to_string(&workspaces.renew_all(&base)?).map_err(io::Error::other)?;
            writeln!(io::stdout(), "{report}")?;
        }
    }
    Ok(0)
}

fn main() -> ExitCode {
    let result = dispatch(Cli::parse()).unwrap_or_else(|error| {
        let _ = writeln!(io::stderr(), "reverie-workspaces: {error}");
        1
    });
    ExitCode::from(u8::try_from(result.rem_euclid(256)).unwrap_or(1))
}
