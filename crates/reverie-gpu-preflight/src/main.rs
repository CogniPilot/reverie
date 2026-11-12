//! Fixed owner-local metadata-only GPU preflight. No mutable engine operation,
//! device workload, program selector or service startup is offered.
use clap::Parser;
use reverie_application::gpu_preflight::{PreflightRequest, observe};
use reverie_contracts::worker_image_switch::WorkerImageId;
use reverie_core::{
    device_policy::NvidiaCdiDevice, ids::ProfileEmployeeId, operations::JournalDigest,
};
use reverie_host::engine_metadata::GpuPreflightEngine;
use std::{error::Error, io::Write, path::PathBuf, process::ExitCode};

const REFUSAL: &[u8] = b"GPU laptop metadata preflight unavailable: verify current owner binding, existing local CDI/driver, immutable UID/GID image and reviewed specification. No setup or laptop change was performed.\n";
#[derive(Parser)]
#[command(
    name = "reverie-worker-gpu",
    args_override_self = true,
    version,
    about = "Read-only current employee GPU/CDI/image metadata preflight; no setup or laptop effects"
)]
struct Arguments {
    #[arg(long)]
    config: PathBuf,
    #[arg(long)]
    employee: String,
    #[arg(long)]
    device: String,
    #[arg(long)]
    image: Option<String>,
    #[arg(long)]
    browser: bool,
    /// Owner-reviewed specification digest; mismatches refuse.
    #[arg(long)]
    cdi_sha256: Option<String>,
}
fn main() -> ExitCode {
    let args = Arguments::parse();
    nix::sys::stat::umask(nix::sys::stat::Mode::from_bits_truncate(0o077));
    match run(args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            let _ = reverie_diagnostics::stderr(REFUSAL);
            // The App failure owner's destruction policy retains an
            // unconfirmed client; known-closed body errors can drop normally.
            drop(error);
            ExitCode::from(77)
        }
    }
}
fn run(args: Arguments) -> Result<(), Box<dyn Error>> {
    let request = PreflightRequest {
        employee: ProfileEmployeeId::parse(&args.employee)?,
        device: NvidiaCdiDevice::parse(&args.device)?,
        image: args
            .image
            .as_deref()
            .filter(|image| !image.is_empty())
            .map(WorkerImageId::parse)
            .transpose()?,
        browser: args.browser,
        cdi_digest: args
            .cdi_sha256
            .as_deref()
            .map(JournalDigest::parse)
            .transpose()?,
    };
    let program = option_env!("REVERIE_FIXED_GPU_PREFLIGHT_ENGINE")
        .ok_or("GPU_PREFLIGHT_PACKAGED_ENGINE_REQUIRED")?;
    let engine = GpuPreflightEngine::capture(program.as_ref())?;
    let raw = observe(&args.config, &request, engine)?;
    let mut output = std::io::stdout().lock();
    output.write_all(&raw)?;
    output.flush()?;
    Ok(())
}
