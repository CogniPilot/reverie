//! `reverie-collect`: `cleanup/collector.py main()`. One sample per run;
//! exit 0 sampled, 2 configuration error, 5 another run holds the lock.
use clap::Parser;
use reverie_contracts::collector::parse_config;
use reverie_contracts::collector_state::os_error;
use reverie_observations::collector::{Failure, sample_once};
use std::io::Write;
use std::os::unix::ffi::OsStrExt;
use std::path::PathBuf;
use std::process::ExitCode;

/// A generic host resource collector. Drive it with a timer.
#[derive(Parser)]
#[command(name = "reverie-collect", infer_long_args = true)]
struct Cli {
    #[arg(
        long,
        default_value = "/etc/reverie/collect.toml",
        overrides_with = "config"
    )]
    config: PathBuf,
    #[arg(value_parser = ["once"])]
    mode: String,
}

/// `load_config(path)`: the file as read, then its TOML table.
fn load(path: &PathBuf) -> Result<reverie_contracts::collector::Config, String> {
    let bytes = std::fs::read(path).map_err(|error| {
        let errno = error.raw_os_error().unwrap_or(libc::EIO);
        let text = std::io::Error::from_raw_os_error(errno).to_string();
        let text = text
            .strip_suffix(&format!(" (os error {errno})"))
            .unwrap_or(&text)
            .to_owned();
        let name = reverie_core::posix_text::decode(path.as_os_str().as_bytes());
        format!("config: {}", os_error(errno, &text, Some(&name)))
    })?;
    let text = String::from_utf8(bytes).map_err(|_| "config: invalid UTF-8".to_owned())?;
    parse_config(&text)
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    debug_assert_eq!(cli.mode, "once");
    let result = load(&cli.config)
        .map_err(Failure::Config)
        .and_then(|cfg| sample_once(&cfg, None));
    let (message, status) = match result {
        Ok(_) => return ExitCode::SUCCESS,
        Err(Failure::Config(message)) => (message, 2),
        Err(Failure::Busy) => ("another run holds the lock".to_owned(), 5),
        Err(Failure::Fatal(message)) => (message, 1),
    };
    let _ = writeln!(std::io::stderr(), "reverie-collect: {message}");
    ExitCode::from(status)
}
