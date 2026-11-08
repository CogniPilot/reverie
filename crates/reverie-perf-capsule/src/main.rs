//! Build-time perf image assembly, never a runtime deployment interface.
#![forbid(unsafe_code)]
mod capsule;
use clap::Parser;
use std::path::PathBuf;

/// Assemble the fixed perf guest tools from immutable Nix build inputs.
/// Output is image data: native launch qualification remains mandatory.
#[derive(Parser)]
#[command(version, about)]
struct Arguments {
    /// Static Rust checker ELF; dynamic entry points are refused.
    #[arg(long)]
    checker: PathBuf,
    /// Actual perf ELF, never its upstream shell wrapper.
    #[arg(long)]
    perf: PathBuf,
    /// Nix closureInfo store-paths file for the selected perf package.
    #[arg(long)]
    closure: PathBuf,
    /// Immutable upstream license and notice directory.
    #[arg(long)]
    notices: PathBuf,
    #[arg(long)]
    patchelf: PathBuf,
    #[arg(long)]
    readelf: PathBuf,
    /// Fresh image-root output directory, never an installed instance.
    #[arg(long)]
    output: PathBuf,
}

fn main() -> std::process::ExitCode {
    match capsule::build(Arguments::parse()) {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("perf capsule build refused: {error}");
            std::process::ExitCode::FAILURE
        }
    }
}

type Result<T> = reverie_elf_bundle::Result<T>;
fn refused(message: &str) -> Box<dyn std::error::Error> {
    std::io::Error::other(message).into()
}
