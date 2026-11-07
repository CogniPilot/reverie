//! `reverie-collect-state`: `cleanup/collector_state.py main()`. One JSON line
//! on stdout and status 0, or `reverie-collect-state: <reason>` on stdout and
//! status 2.
use clap::Parser;
use reverie_contracts::collector_state::{NOT_ADMINISTRATOR, ready};
use reverie_observations::collector_state::{StateError, prepare};
use std::ffi::OsString;
use std::io::Write;
use std::os::unix::ffi::OsStrExt;
use std::process::ExitCode;

/// Prepare private collector output without adopting another application's data.
#[derive(Parser)]
#[command(name = "reverie-collect-state")]
struct Cli {
    #[arg(long, overrides_with = "state_dir")]
    state_dir: OsString,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let value = reverie_core::posix_text::decode(cli.state_dir.as_bytes());
    let result = if nix::unistd::geteuid().is_root() {
        prepare(&value, &[0])
    } else {
        Err(StateError::Refused(NOT_ADMINISTRATOR))
    };
    let (line, status) = match result {
        Ok(state) => (ready(&state), 0),
        Err(error) => (format!("reverie-collect-state: {}", error.message()), 2),
    };
    match writeln!(std::io::stdout(), "{line}") {
        Ok(()) => ExitCode::from(status),
        Err(_) => ExitCode::from(2),
    }
}
