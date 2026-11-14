//! Build-time worker API client capsule. Artifact data, never runtime authority.
#![forbid(unsafe_code)]
mod capsule;
mod manifest;

use clap::Parser;
use std::path::PathBuf;

/// Assemble an agent-only client outside a worker's private Nix store.
#[derive(Parser)]
#[command(version, about)]
struct Arguments {
    #[arg(long)]
    node: PathBuf,
    #[arg(long)]
    entry: PathBuf,
    #[arg(long)]
    bundle: PathBuf,
    #[arg(long)]
    legal: PathBuf,
    #[arg(long)]
    hooks: PathBuf,
    #[arg(long)]
    notices: PathBuf,
    #[arg(long)]
    closure: PathBuf,
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
            eprintln!("worker client capsule build refused: {error}");
            std::process::ExitCode::FAILURE
        }
    }
}

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
fn refused(message: &str) -> Box<dyn std::error::Error> {
    std::io::Error::other(message).into()
}
