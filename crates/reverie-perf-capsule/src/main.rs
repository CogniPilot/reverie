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
    /// Static fixed-purpose worker PID1 ELF; no command or exec selectors.
    #[arg(long)]
    worker_init: PathBuf,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_two_requires_explicit_worker_init_input() {
        let arguments = [
            "reverie-perf-capsule",
            "--checker",
            "/nix/store/checker",
            "--perf",
            "/nix/store/perf",
            "--closure",
            "/nix/store/closure",
            "--notices",
            "/nix/store/notices",
            "--patchelf",
            "/nix/store/patchelf",
            "--readelf",
            "/nix/store/readelf",
            "--output",
            "/fresh-output",
        ];
        assert!(Arguments::try_parse_from(arguments).is_err());
        let mut complete = arguments.to_vec();
        complete.extend(["--worker-init", "/nix/store/worker-init"]);
        let parsed = Arguments::try_parse_from(complete).expect("explicit v2 inputs");
        assert_eq!(parsed.worker_init, PathBuf::from("/nix/store/worker-init"));
    }
}
