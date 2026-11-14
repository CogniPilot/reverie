//! Build-time fixed worker tmux capsule. Artifact data, never runtime authority.
#![forbid(unsafe_code)]
mod capsule;
mod manifest;

use clap::Parser;
use std::path::PathBuf;

/// Assemble the fixed tmux and terminal data outside private writable Nix.
#[derive(Parser)]
#[command(version, about)]
struct Arguments {
    #[arg(long)]
    tmux: PathBuf,
    #[arg(long)]
    closure: PathBuf,
    #[arg(long)]
    terminfo: PathBuf,
    #[arg(long)]
    notices: PathBuf,
    #[arg(long)]
    locale_archive: PathBuf,
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
            eprintln!("worker tools capsule build refused: {error}");
            std::process::ExitCode::FAILURE
        }
    }
}
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
fn refused(message: &str) -> Box<dyn std::error::Error> {
    std::io::Error::other(message).into()
}
