//! Build-only artifact producer; no service/runtime/owner operation entrypoint.
use clap::Parser;
use reverie_contracts::task_perf_v1::{MAX_ARTIFACT_BYTES, PerfSystem, produce_task_perf};
use std::path::{Path, PathBuf};
mod output;

#[derive(Parser)]
#[command(
    version,
    about = "Build the fixed task-v1 seccomp profile and manifest",
    long_about = "Build-only Nix tool. Read a fixed base profile and write task-perf-seccomp.json and worker-perf-profile.json into an existing empty output directory. This does not configure a server, grant permissions, invoke an engine, or prove installed artifact custody.",
    after_help = "Example:\n  reverie-policy-artifacts --base-profile /nix/store/BASE.json --output-directory /nix/store/OUTPUT/share/reverie --system x86_64-linux\n\nExisting output files are refused. A failed build may leave partial output; Nix must publish only successful derivations."
)]
struct Arguments {
    /// Immutable Docker seccomp base selected by the build expression.
    #[arg(long)]
    base_profile: PathBuf,
    /// Existing build-owned directory; each output must be absent.
    #[arg(long)]
    output_directory: PathBuf,
    /// Target system, selected by the Nix build (not the builder's host).
    #[arg(long, value_parser = ["x86_64-linux", "aarch64-linux"])]
    system: String,
}
fn main() {
    if let Err(error) = run(Arguments::parse()) {
        eprintln!("POLICY_ARTIFACT_BUILD_REFUSED: {error}");
        std::process::exit(1);
    }
}
fn run(args: Arguments) -> Result<(), Box<dyn std::error::Error>> {
    let system = PerfSystem::from_name(&args.system)?;
    let base = output::read_bounded(&args.base_profile, MAX_ARTIFACT_BYTES)?;
    let profile = args.output_directory.join("task-perf-seccomp.json");
    let manifest = args.output_directory.join("worker-perf-profile.json");
    let generated = produce_task_perf(utf8(&args.base_profile)?, utf8(&profile)?, system, &base)?;
    output::write_new_pair(
        &profile,
        generated.profile(),
        &manifest,
        generated.manifest(),
    )?;
    Ok(())
}
fn utf8(path: &Path) -> Result<&str, std::io::Error> {
    path.to_str().ok_or(std::io::ErrorKind::InvalidInput.into())
}
