//! Build-only artifact producer; no service/runtime/owner operation entrypoint.
use clap::Parser;
use reverie_contracts::docker_profile::{MAX_PROFILE_BYTES, produce_docker_profile};
use reverie_contracts::task_perf_v1::{
    MAX_ARTIFACT_BYTES, PerfSystem, TaskPerfPolicy, produce_task_perf_for_policy,
};
use std::path::{Path, PathBuf};
mod build_archive;
mod build_input;
mod codex_inputs;
mod human_toolkit;
mod idmap;
mod output;
mod pool_images;
mod verify;
mod website_provenance;
mod worker_child;
mod worker_provenance;

#[derive(Parser)]
#[command(
    version,
    about = "Build fixed Docker namespace or versioned task perf seccomp artifacts",
    long_about = "Build-only Nix tool. Docker mode appends the fixed namespace rule to the default-deny upstream profile. Task-perf mode writes task-perf-seccomp.json and worker-perf-profile.json into an existing output directory. This does not configure a server, grant permissions, invoke an engine, or prove installed artifact custody.",
    after_help = "Docker base:\n  reverie-policy-artifacts --base-profile /nix/store/UPSTREAM.json --docker-profile-output /build/worker-docker-seccomp.json\n\nTask perf:\n  reverie-policy-artifacts --base-profile /nix/store/BASE.json --output-directory /nix/store/OUTPUT/share/reverie --system x86_64-linux\n\nModes are mutually exclusive. Existing output files are refused. A failed build may leave partial output; Nix must publish only successful derivations."
)]
struct Arguments {
    /// Immutable Docker seccomp base selected by the build expression.
    #[arg(long, required_unless_present = "verify_manifest")]
    base_profile: Option<PathBuf>,
    /// Existing build-owned directory; each output must be absent.
    #[arg(long, required_unless_present_any = ["docker_profile_output", "verify_manifest"])]
    output_directory: Option<PathBuf>,
    /// Target system, selected by the Nix build (not the builder's host).
    #[arg(long, required_unless_present_any = ["docker_profile_output", "verify_manifest"], value_parser = ["x86_64-linux", "aarch64-linux"])]
    system: Option<String>,
    /// Explicit new task policy. Omission retains the byte-compatible v1 producer.
    #[arg(long, value_parser = ["task-v1", "task-v2"], conflicts_with_all = ["docker_profile_output", "verify_manifest"])]
    task_perf_policy: Option<String>,
    /// Docker mode: absent output file for the fixed namespace profile.
    #[arg(long, conflicts_with_all = ["output_directory", "system"])]
    docker_profile_output: Option<PathBuf>,
    /// Read-only validation of generated versioned task perf bytes for acceptance.
    #[arg(long, conflicts_with_all = ["base_profile", "output_directory", "system", "docker_profile_output"])]
    verify_manifest: Option<PathBuf>,
}
fn main() {
    let result = if human_toolkit::requested() {
        human_toolkit::run()
    } else if worker_provenance::requested() {
        worker_provenance::run()
    } else if website_provenance::requested() {
        website_provenance::run()
    } else if idmap::requested() {
        idmap::run()
    } else if codex_inputs::requested() {
        codex_inputs::run()
    } else if pool_images::requested() {
        pool_images::run()
    } else if worker_child::requested() {
        worker_child::run()
    } else {
        run(Arguments::parse())
    };
    if let Err(error) = result {
        eprintln!("POLICY_ARTIFACT_BUILD_REFUSED: {error}");
        std::process::exit(1);
    }
}
fn run(args: Arguments) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(manifest) = args.verify_manifest {
        print!("{}", verify::profile(&manifest)?);
        return Ok(());
    }
    let base_profile = args
        .base_profile
        .ok_or(std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    if let Some(destination) = args.docker_profile_output {
        let base = output::read_bounded(&base_profile, MAX_PROFILE_BYTES)?;
        output::write_new(&destination, &produce_docker_profile(&base)?)?;
        return Ok(());
    }
    let system = PerfSystem::from_name(
        args.system
            .as_deref()
            .ok_or(std::io::Error::from(std::io::ErrorKind::InvalidInput))?,
    )?;
    let base = output::read_bounded(&base_profile, MAX_ARTIFACT_BYTES)?;
    let directory = args
        .output_directory
        .ok_or(std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let profile = directory.join("task-perf-seccomp.json");
    let manifest = directory.join("worker-perf-profile.json");
    let policy = match args.task_perf_policy.as_deref() {
        None => TaskPerfPolicy::TaskV1,
        Some(value) => TaskPerfPolicy::from_name(value)
            .ok_or(std::io::Error::from(std::io::ErrorKind::InvalidInput))?,
    };
    let generated =
        produce_task_perf_for_policy(policy, utf8(&base_profile)?, utf8(&profile)?, system, &base)?;
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
