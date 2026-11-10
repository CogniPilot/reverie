//! Linux adapter for the existing private worker client protocol.
mod cli;
pub mod control;
mod custody;
mod error;
mod frame;
mod json;
mod native;
mod relay;
mod report;
#[cfg(test)]
mod test_support;

use clap::Parser;
use cli::{Args, Operation};
pub use error::ControlError;
use error::ControlError as Error;
use frame::Connection;
use std::time::{Duration, Instant};
type Result<T> = std::result::Result<T, Error>;

fn execute(operation: Operation) -> Result<u8> {
    if matches!(operation, Operation::Custody { .. }) {
        return custody::run(operation);
    }
    let limit = match &operation {
        Operation::Control(_) => Some(control::LIMIT),
        Operation::Report(_) => Some(Duration::from_secs(3)),
        _ => None,
    };
    let mut connection = Connection::open(limit.map(|limit| Instant::now() + limit))?;
    let result = match operation {
        Operation::Launch { request, reference } => relay::run(&mut connection, request, reference),
        Operation::Control(request) => {
            let result = if request.get("action").and_then(serde_json::Value::as_str)
                == Some("quiesce-for-deployment")
            {
                control::exchange_quiesce(&mut connection)
            } else {
                control::exchange(&mut connection, request)
            };
            let raw = connection.finish(result)?;
            return emit(&raw);
        }
        Operation::Report(employees) => {
            let result = report::run(&mut connection, &employees);
            let raw = connection.finish(result)?;
            return emit(&raw);
        }
        Operation::Custody { .. } => unreachable!(),
    };
    connection.finish(result)
}
fn emit(raw: &[u8]) -> Result<u8> {
    use std::io::Write;
    let mut output = std::io::stdout().lock();
    output.write_all(raw)?;
    output.write_all(b"\n")?;
    output.flush()?;
    Ok(0)
}

/// Execute the existing CLI. Library callers should use the fixed one-shot
/// control API instead; this entry handles command-line argv and stdio.
pub fn run_cli() -> std::process::ExitCode {
    if normalize_argv0().is_err() {
        eprintln!("Reverie worker unavailable: executable identity could not be normalized");
        return std::process::ExitCode::FAILURE;
    }
    let args = Args::parse();
    let custody = args.goal_custody || args.goal_custody_stream;
    match args.operation().and_then(execute) {
        Ok(code) => std::process::ExitCode::from(code),
        Err(error) => {
            if custody {
                eprintln!("Private Goal custody unavailable");
            } else {
                eprintln!("Reverie worker unavailable: {}", error.message());
            }
            std::process::ExitCode::FAILURE
        }
    }
}

fn normalize_argv0() -> std::io::Result<()> {
    use std::os::unix::process::CommandExt;
    let executable = std::env::current_exe()?;
    let mut arguments = std::env::args_os();
    if arguments.next().as_deref() != Some(executable.as_os_str()) {
        return Err(std::process::Command::new(&executable)
            .arg0(&executable)
            .args(arguments)
            .exec());
    }
    Ok(())
}
