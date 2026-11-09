//! Fixed in-worker performance check; never a deployment or engine tool.
use clap::Parser;
use reverie_core::{operations::JournalId, shutdown::ShutdownStatus};
use reverie_host::task_perf::guest::{PerfCheckError, PerfGuestCheck, run_fixed_workload};
use std::{
    process::ExitCode,
    time::{Duration, Instant},
};

#[derive(Parser)]
#[command(
    about = "Verify unprivileged task perf in this exact employee laptop.",
    long_about = "Run the image's fixed task-clock:u stat, inherited recording and report against a short two-thread Rust workload. The broker supplies a fresh correlation nonce and must independently bind the result to the actual laptop incarnation, selected task-v2 policy and resource readback. This command changes no host settings and accepts no paths, events, programs, durations, engine arguments or passed-skip mode."
)]
struct Arguments {
    /// Fresh correlation reference from the actual owning launch, not authority.
    #[arg(long, required_unless_present = "workload", conflicts_with = "workload", value_parser = nonce)]
    nonce: Option<JournalId>,
    #[arg(long, hide = true)]
    workload: bool,
}
fn nonce(raw: &str) -> Result<JournalId, String> {
    JournalId::parse(raw).map_err(|_| "Expected a canonical UUID correlation nonce".to_owned())
}
fn main() -> ExitCode {
    let arguments = Arguments::parse();
    if arguments.workload {
        return match run_fixed_workload() {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                report(&error);
                ExitCode::FAILURE
            }
        };
    }
    let mut owner = match PerfGuestCheck::installed() {
        Ok(owner) => owner,
        Err(error) => {
            report(&error);
            return ExitCode::FAILURE;
        }
    };
    let end = Instant::now() + Duration::from_secs(15);
    let result = owner.check(
        arguments.nonce.expect("Clap requires nonce in check mode"),
        end,
    );
    let cleanup = settle(&mut owner, end);
    if let Some(signal) = owner.termination_signal() {
        if let Err(error) = &result {
            report(error);
        }
        if let Some(error) = &cleanup {
            report(error);
        }
        return ExitCode::from((128 + signal) as u8);
    }
    match (result, cleanup) {
        (Ok(data), None) => match data.encode() {
            Ok(mut bytes) => {
                bytes.push(b'\n');
                if reverie_diagnostics::stdout(&bytes).is_ok() {
                    ExitCode::SUCCESS
                } else {
                    ExitCode::FAILURE
                }
            }
            Err(error) => {
                report(&error);
                ExitCode::FAILURE
            }
        },
        (primary, cleanup) => {
            if let Err(error) = primary {
                report(&error);
            }
            if let Some(error) = cleanup {
                report(&error);
            }
            let (out, err) = owner.diagnostics();
            diagnostic(out);
            diagnostic(err);
            ExitCode::FAILURE
        }
    }
}
fn settle(owner: &mut PerfGuestCheck, end: Instant) -> Option<PerfCheckError> {
    let mut state = owner.shutdown(end);
    loop {
        match state {
            ShutdownStatus::Complete => return None,
            ShutdownStatus::Refused(error) => return Some(error),
            ShutdownStatus::Pending(_) => {
                std::thread::sleep(Duration::from_millis(50));
                state = owner.shutdown(Instant::now());
            }
        }
    }
}
fn report(error: &dyn std::fmt::Display) {
    let _ = reverie_diagnostics::stderr(format!("Reverie perf check failed: {error}\n").as_bytes());
}
fn diagnostic(bytes: &[u8]) {
    for chunk in bytes.chunks(reverie_diagnostics::MAX_BYTES) {
        if reverie_diagnostics::stderr(chunk).is_err() {
            break;
        }
    }
}
