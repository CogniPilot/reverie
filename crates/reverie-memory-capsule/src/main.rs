//! Build-time image capsule producer. No runtime request or execution authority.
#![forbid(unsafe_code)]
mod capsule;
mod execution;
mod files;
use clap::Parser;
use std::path::PathBuf;

/// Assemble the fixed guest memory toolchain from immutable Nix build inputs.
/// The output is image DATA; only the real installer/launch owner can adopt it.
#[derive(Parser)]
#[command(version, about)]
struct Arguments {
    #[arg(long)]
    console: PathBuf,
    #[arg(long)]
    node: PathBuf,
    #[arg(long)]
    memory: PathBuf,
    #[arg(long)]
    mcp: PathBuf,
    #[arg(long)]
    closure: PathBuf,
    #[arg(long)]
    modules: PathBuf,
    #[arg(long)]
    notices: PathBuf,
    #[arg(long)]
    patchelf: PathBuf,
    #[arg(long)]
    readelf: PathBuf,
    #[arg(long)]
    output: PathBuf,
}

fn main() -> std::process::ExitCode {
    match capsule::build(Arguments::parse()) {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("memory capsule build refused: {error}");
            std::process::ExitCode::FAILURE
        }
    }
}

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
fn refused(message: &str) -> Box<dyn std::error::Error> {
    std::io::Error::other(message).into()
}
