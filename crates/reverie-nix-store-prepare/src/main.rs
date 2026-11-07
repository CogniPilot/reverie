//! Fixed unprivileged image helper; no host engine or public command surface.
use clap::Parser;
use reverie_core::shutdown::ShutdownStatus;
use reverie_host::worker_nix::guest::{GuestNixSeed, SeedError};
use std::{
    process::ExitCode,
    time::{Duration, Instant},
};

#[derive(Parser)]
#[command(
    about = "Seed the mounted private Nix store from this worker image.",
    long_about = "Run inside the networkless worker preparation helper. Import the installed image registration privately, copy its registered closure offline into /target/nix, and retain the image GC root. Programs, inputs and destinations are fixed; this command accepts no paths, engine arguments or admission grants."
)]
struct Arguments {}

fn main() -> ExitCode {
    let _ = Arguments::parse();
    let mut owner = match GuestNixSeed::installed() {
        Ok(owner) => owner,
        Err(error) => {
            report(&error);
            return ExitCode::FAILURE;
        }
    };
    // The real broker preparation has this original overall five-minute
    // budget. Its outer deadline remains authoritative; this guest cannot
    // extend it. A signal clamps owned cleanup to the first stop's 34 seconds.
    let deadline = Instant::now() + Duration::from_secs(300);
    let primary = owner.seed(deadline).err();
    let cleanup = settle(&mut owner, deadline);
    // Delivery is best effort and follows settlement, including negative
    // terminal settlement. No output result can rewrite the actual exit.
    let (stdout, stderr) = owner.output();
    offer(stdout, reverie_diagnostics::stdout);
    offer(stderr, reverie_diagnostics::stderr);
    if let Some(error) = &primary {
        report(error);
    }
    if let Some(error) = &cleanup {
        report(error);
    }
    let code = owner.termination_signal().map_or_else(
        || {
            primary
                .as_ref()
                .or(cleanup.as_ref())
                .map_or(0, SeedError::exit_code)
        },
        |signal| (128 + signal) as u8,
    );
    ExitCode::from(code)
}
fn settle(owner: &mut GuestNixSeed, deadline: Instant) -> Option<SeedError> {
    let mut status = owner.shutdown(deadline);
    loop {
        match status {
            ShutdownStatus::Complete => return None,
            ShutdownStatus::Refused(error) => return Some(error),
            ShutdownStatus::Pending(_) => {
                // Observe only the exact retained constructor/process. No new
                // budget, spawn, signal retry or replacement is admitted.
                std::thread::sleep(Duration::from_millis(50));
                status = owner.shutdown(Instant::now());
            }
        }
    }
}
fn offer(bytes: &[u8], output: fn(&[u8]) -> std::io::Result<()>) {
    for chunk in bytes.chunks(reverie_diagnostics::MAX_BYTES) {
        if output(chunk).is_err() {
            break;
        }
    }
}
fn report(error: &SeedError) {
    let _ = reverie_diagnostics::stderr(
        format!("Reverie Nix preparation failed: {error}\n").as_bytes(),
    );
}
