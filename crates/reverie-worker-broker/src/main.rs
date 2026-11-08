//! Fixed native broker role. This program never replaces itself with another
//! executable. Origin delegation becomes invalid on replacement/rebootstrap.
use clap::{Parser, Subcommand};
use reverie_application::{
    installing_broker::InstallingBroker, worker_validation::load_owner_config,
};
use reverie_host::{
    engine_metadata::EngineBootstrap, installed_worker_engine::InstalledWorkerEngine,
    worker_runtime::WorkerRuntime,
};
use std::{path::PathBuf, process::ExitCode};
mod manifest;

#[derive(Parser)]
#[command(
    version,
    about = "Native worker broker (unselected integration package)",
    long_about = "Fixed broker --config role over the installing Runtime and registered handler owners. This integration package does not advertise fleet/pool/all-verb readiness and is not selected by the shipped hybrid service. No arbitrary command or runtime engine path is accepted."
)]
struct Arguments {
    #[command(subcommand)]
    command: Role,
}
#[derive(Subcommand)]
enum Role {
    /// Run the native service from an actual owner-custodied configuration.
    Broker {
        #[arg(long)]
        config: PathBuf,
    },
    /// Offer the OS-selected worker pool, then serve for explicit owner consent.
    /// Reads ~/reverie/worker-pool/registration-request.json using the system
    /// account home. It does not accept a request path or install from JSON alone.
    OfferPoolV1 {
        #[arg(long)]
        config: PathBuf,
    },
    /// Nix build only: write the fixed output-slot manifest AFTER fixup.
    OriginManifest,
}
fn main() -> ExitCode {
    match run(Arguments::parse()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("NATIVE_WORKER_BROKER_REFUSED: {error}");
            ExitCode::FAILURE
        }
    }
}
fn run(arguments: Arguments) -> Result<(), Box<dyn std::error::Error>> {
    match arguments.command {
        Role::OriginManifest => Ok(manifest::publish()?),
        Role::Broker { config } => serve(config, false),
        Role::OfferPoolV1 { config } => serve(config, true),
    }
}
fn serve(config: PathBuf, offer: bool) -> Result<(), Box<dyn std::error::Error>> {
    let snapshot = load_owner_config(&config)?;
    let program = option_env!("REVERIE_FIXED_NATIVE_WORKER_ENGINE")
        .ok_or("NATIVE_WORKER_BROKER_PACKAGED_ENGINE_REQUIRED")?;
    let engine = InstalledWorkerEngine::new(EngineBootstrap::capture(program.as_ref())?);
    let runtime = WorkerRuntime::new(engine, snapshot.envelope().base());
    let broker = InstallingBroker::new(snapshot, runtime)?;
    let startup = if offer {
        broker
            .prepare_os_pool_installation_offer(
                std::time::Instant::now() + std::time::Duration::from_secs(300),
            )?
            .prepare_service()?
    } else {
        broker.prepare_service()?
    };
    let service = startup.bind_listener()?;
    // Failure keeps the SAME service and original retained handler
    // stacks; a nonzero process result is never a cleanup ACK.
    service.run()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn installation_role_has_fixed_name_config_and_no_nomination_override() {
        let arguments = Arguments::try_parse_from([
            "broker",
            "offer-pool-v1",
            "--config",
            "/owner/broker.json",
        ])
        .unwrap();
        assert!(matches!(arguments.command, Role::OfferPoolV1 { .. }));
        for extra in ["--request", "--principal", "--force", "--command"] {
            assert!(
                Arguments::try_parse_from([
                    "broker",
                    "offer-pool-v1",
                    "--config",
                    "/owner/broker.json",
                    extra,
                    "arbitrary"
                ])
                .is_err()
            );
        }
        assert!(
            Arguments::try_parse_from(["broker", "broker", "--config", "/owner/broker.json"])
                .is_ok()
        );
    }
}
