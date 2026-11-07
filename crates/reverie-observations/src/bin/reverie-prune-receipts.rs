//! `reverie-prune-receipts`: `cleanup/receipts.py main()`. One JSON summary
//! line on stdout; exit 0 ok, 1 refusals or conflicts, 2 usage, 3 output UNKNOWN.
use clap::{CommandFactory, Parser};
use reverie_contracts::prune_receipts::{Limits, python_float, python_int};
use reverie_observations::receipts::{Options, Prescan, prescan, run};
use std::ffi::OsString;
use std::io::Write;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::{SystemTime, UNIX_EPOCH};

fn integer(text: &str) -> Result<i64, String> {
    python_int(text)
        .and_then(|value| i64::try_from(value).ok())
        .ok_or_else(|| format!("invalid int value: '{text}'"))
}

fn float(text: &str) -> Result<f64, String> {
    python_float(text).ok_or_else(|| format!("invalid float value: '{text}'"))
}

/// Closed adapter: reverie-prune run summaries and A1 exception reports -> receipt-shaped records (RECEIPTS lane).
#[derive(Parser)]
#[command(name = "reverie-prune-receipts", infer_long_args = true)]
struct Cli {
    /// reverie-prune log_dir (reads *.summary.json)
    #[arg(long, allow_hyphen_values = true, overrides_with = "log_dir")]
    log_dir: Option<OsString>,
    /// an A1 report JSON; repeatable
    #[arg(long, allow_hyphen_values = true)]
    a1: Vec<OsString>,
    /// operator's trusted producer context JSON
    #[arg(long, allow_hyphen_values = true, overrides_with = "context")]
    context: Option<OsString>,
    /// append-only receipts JSONL
    #[arg(long, allow_hyphen_values = true, overrides_with = "out")]
    out: OsString,
    #[arg(long, default_value = "1048576", allow_hyphen_values = true, value_parser = integer, overrides_with = "max_input_bytes")]
    max_input_bytes: i64,
    #[arg(long, default_value = "100000", allow_hyphen_values = true, value_parser = integer, overrides_with = "max_entries")]
    max_entries: i64,
    #[arg(long, default_value = "67108864", allow_hyphen_values = true, value_parser = integer, overrides_with = "max_bytes")]
    max_bytes: i64,
    #[arg(long, default_value = "0", allow_hyphen_values = true, value_parser = float, overrides_with = "max_age_days")]
    max_age_days: f64,
}

fn main() -> ExitCode {
    // argparse reads the arguments left to right: an earlier help option
    // wins, and an earlier usage error exits 2 before any file effect.
    // Every value option takes hyphen values in clap; prescan decides.
    let args = std::env::args_os().skip(1).collect::<Vec<_>>();
    match prescan(&args) {
        Prescan::Help => {
            let _ = Cli::command().print_help();
            return ExitCode::SUCCESS;
        }
        Prescan::Usage(message) => {
            eprintln!("reverie-prune-receipts: error: {message}");
            return ExitCode::from(2);
        }
        Prescan::Parse => {}
    }
    let cli = Cli::parse();
    // Paths are plain strings: an empty one is accepted, and false in Python.
    let present = |path: Option<OsString>| path.filter(|path| !path.is_empty()).map(PathBuf::from);
    let options = Options {
        log_dir: present(cli.log_dir),
        a1: cli.a1.into_iter().map(PathBuf::from).collect(),
        context: present(cli.context),
        out: PathBuf::from(cli.out),
        max_input_bytes: cli.max_input_bytes,
        limits: Limits {
            entries: cli.max_entries,
            bytes: cli.max_bytes,
            age_days: cli.max_age_days,
        },
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |elapsed| elapsed.as_secs_f64());
    match run(&options, now) {
        Ok((code, line)) => {
            let mut stdout = std::io::stdout();
            if stdout
                .write_all(line.as_bytes())
                .and_then(|()| stdout.flush())
                .is_err()
            {
                return ExitCode::from(1);
            }
            ExitCode::from(u8::try_from(code).unwrap_or(1))
        }
        Err(crash) => {
            // Python printed a traceback; the class name stands for it.
            eprintln!("reverie-prune-receipts: uncaught {}", crash.0);
            ExitCode::from(1)
        }
    }
}
