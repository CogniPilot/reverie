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
mod image;
mod inventory;
mod manifest;
mod offline_owner;
mod perf;
mod pool_image_inputs;
mod service;

#[derive(Parser)]
#[command(
    version,
    about = "Native worker broker and owner bootstrap",
    long_about = "Run the worker service, validate configuration, or manage a registered native installation. Use 'image preview' before 'image apply'. Applying an image requires an already-loaded factory image, an inactive native service, and physically stopped workers. Image apply changes the selected image; it does not start the service or recreate laptops. See each subcommand's --help for its required inputs."
)]
struct Arguments {
    #[command(subcommand)]
    command: Role,
}
#[derive(Subcommand)]
enum Role {
    /// Read the registered OS-owner employee/declared-plan inventory without
    /// starting a broker or exposing private model, thread or account fields.
    Inventory {
        #[arg(long, value_name = "FILE")]
        config: PathBuf,
    },
    /// Qualify, preview and apply an offline worker-image pin through the native
    /// application service. This never loads images or recreates laptops.
    Image {
        #[command(subcommand)]
        action: image::Action,
    },
    /// Preview or apply employee task profiling policy while the registered
    /// service and workers are stopped. Apply preserves employee data and
    /// does not restart the service or recreate laptops.
    Perf {
        #[command(subcommand)]
        action: perf::Action,
    },
    /// Validate an existing configuration and print its snapshot digest as JSON.
    /// Reads the file and its declared host paths without starting the broker.
    CheckConfig {
        /// Owner-custodied configuration file; validation preserves its bytes.
        #[arg(long, value_name = "FILE")]
        config: PathBuf,
    },
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
    /// Build only: publish the fixed native user unit in its packaged slot.
    ServiceUnit,
    /// Explicit ordinary-owner native unit bootstrap/control.
    Service {
        action: service::Action,
        #[arg(long)]
        start_previous: bool,
        /// Start the new broker only after a known completed native upgrade.
        #[arg(long)]
        restart: bool,
        /// After proving the exact stopped service has no processes or populated
        /// cgroup, archive its old unresolved markers instead of losing history.
        /// This does not acknowledge previous runtime or resource outcomes.
        #[arg(long)]
        force_stopped: bool,
        #[arg(long)]
        config: PathBuf,
    },
}
fn main() -> ExitCode {
    match run(Arguments::parse()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("NATIVE_WORKER_BROKER_REFUSED: {error}");
            std::mem::forget(error);
            ExitCode::FAILURE
        }
    }
}
fn run(arguments: Arguments) -> Result<(), Box<dyn std::error::Error>> {
    match arguments.command {
        Role::Inventory { config } => inventory::run(&config),
        Role::Image { action } => image::run(action),
        Role::Perf { action } => perf::run(action),
        Role::CheckConfig { config } => {
            let snapshot = load_owner_config(&config).inspect_err(|error| {
                eprintln!("Configuration validation stage: {:?}", error.stage());
            })?;
            println!(
                "{}",
                serde_json::json!({
                    "valid": true,
                    "source": snapshot.source_path().and_then(std::path::Path::to_str),
                    "configurationDigest": reverie_contracts::worker_config::config_digest(
                        snapshot.configuration()
                    ).to_hex()
                })
            );
            Ok(())
        }
        Role::OriginManifest => Ok(manifest::publish()?),
        Role::ServiceUnit => Ok(manifest::publish_service_unit()?),
        Role::Service {
            action,
            config,
            start_previous,
            restart,
            force_stopped,
        } => service::run(action, &config, start_previous, restart, force_stopped),
        Role::Broker { config } => serve(config, false),
        Role::OfferPoolV1 { config } => serve(config, true),
    }
}
fn serve(config: PathBuf, offer: bool) -> Result<(), Box<dyn std::error::Error>> {
    let snapshot = load_owner_config(&config)?;
    let source = snapshot
        .source_path()
        .ok_or("NATIVE_SERVICE_ORIGINAL_SOURCE_REQUIRED")?
        .to_owned();
    reverie_host::worker_service::assert_no_service_failure(&source)?;
    let engine = captured_engine()?;
    let run_fence = reverie_host::worker_service::begin_service_run(&source)?;
    // A delayed start may span a completed image transition. Publish the run
    // fence first, then load the snapshot that the runtime will actually own.
    let snapshot =
        load_owner_config(&source).map_err(|primary| fenced_failure(&source, primary))?;
    let runtime = WorkerRuntime::new(engine, snapshot.envelope().base());
    let broker = InstallingBroker::new(snapshot, runtime)
        .map_err(|primary| fenced_failure(&source, primary))?;
    let startup = if offer {
        broker
            .prepare_os_pool_installation_offer(
                std::time::Instant::now() + std::time::Duration::from_secs(300),
            )
            .map_err(|primary| fenced_failure(&source, primary))?
            .prepare_service()
            .map_err(|primary| fenced_failure(&source, primary))?
    } else {
        broker
            .prepare_service()
            .map_err(|primary| fenced_failure(&source, primary))?
    };
    let service = startup
        .bind_listener()
        .map_err(|primary| fenced_failure(&source, primary))?;
    // Failure keeps the SAME service and original retained handler
    // stacks; a nonzero process result is never a cleanup ACK.
    service
        .run()
        .map_err(|primary| fenced_failure(&source, primary))?;
    run_fence
        .finish_known()
        .map_err(|primary| fenced_failure(&source, primary))?;
    Ok(())
}
fn captured_engine() -> Result<InstalledWorkerEngine, Box<dyn std::error::Error>> {
    let program = option_env!("REVERIE_FIXED_NATIVE_WORKER_ENGINE")
        .ok_or("NATIVE_WORKER_BROKER_PACKAGED_ENGINE_REQUIRED")?;
    Ok(InstalledWorkerEngine::new(EngineBootstrap::capture(
        program.as_ref(),
    )?))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_upgrade_exposes_explicit_restart_and_force_stopped() {
        let arguments = Arguments::try_parse_from([
            "broker",
            "service",
            "upgrade",
            "--config",
            "/owner/reverie/broker.json",
            "--restart",
            "--force-stopped",
        ])
        .unwrap();
        assert!(matches!(
            arguments.command,
            Role::Service {
                action: service::Action::Upgrade,
                restart: true,
                force_stopped: true,
                start_previous: false,
                ..
            }
        ));
    }
    #[test]
    fn owner_inventory_has_one_config_selector_and_no_private_path_overrides() {
        assert!(matches!(
            Arguments::try_parse_from([
                "broker",
                "inventory",
                "--config",
                "/owner/reverie/broker.json"
            ])
            .unwrap()
            .command,
            Role::Inventory { .. }
        ));
        for flag in ["--company", "--state", "--plan-file", "--engine", "--home"] {
            assert!(
                Arguments::try_parse_from([
                    "broker",
                    "inventory",
                    "--config",
                    "/owner/reverie/broker.json",
                    flag,
                    "/foreign"
                ])
                .is_err()
            );
        }
    }
    #[test]
    fn image_preview_accepts_exact_pinned_profile_inputs_without_an_engine_override() {
        let args = [
            "broker",
            "image",
            "preview",
            "--config",
            "/owner/reverie/broker.json",
            "--provenance",
            "/nix/store/profile/worker-image.json",
            "--provenance-sha256",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "--child-annex",
            "/nix/store/profile/worker-child-image.json",
            "--child-annex-sha256",
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "--image",
            "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        ];
        assert!(Arguments::try_parse_from(args).is_ok());
        let mut foreign = args.to_vec();
        foreign.extend(["--engine", "/caller/program"]);
        assert!(Arguments::try_parse_from(foreign).is_err());
    }
    #[test]
    fn image_apply_requires_the_explicit_preview_and_original_operation() {
        let args = [
            "broker",
            "image",
            "apply",
            "--config",
            "/owner/reverie/broker.json",
            "--provenance",
            "/nix/store/profile/worker-image.json",
            "--provenance-sha256",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "--child-annex",
            "/nix/store/profile/worker-child-image.json",
            "--child-annex-sha256",
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "--image",
            "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        ];
        assert!(Arguments::try_parse_from(args).is_err());
        let mut selected = args.to_vec();
        selected.extend([
            "--expected-preview",
            "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
            "--operation-id",
            "10000000-0000-4000-8000-000000000001",
        ]);
        assert!(Arguments::try_parse_from(selected).is_ok());
    }
    #[test]
    fn config_check_requires_an_explicit_source_and_accepts_no_engine_override() {
        assert!(
            Arguments::try_parse_from([
                "broker",
                "check-config",
                "--config",
                "/owner/reverie/broker.json"
            ])
            .is_ok()
        );
        assert!(Arguments::try_parse_from(["broker", "check-config"]).is_err());
        assert!(
            Arguments::try_parse_from([
                "broker",
                "check-config",
                "--config",
                "/owner/reverie/broker.json",
                "--engine",
                "/caller/program"
            ])
            .is_err()
        );
    }
    #[test]
    fn curated_service_exposes_happy_path_rollback() {
        let parsed = Arguments::try_parse_from([
            "broker",
            "service",
            "rollback",
            "--config",
            "/owner/reverie/broker.json",
        ]);
        assert!(
            parsed.is_ok(),
            "curated service rollback command must be available"
        );
    }
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

fn fenced_failure<E: std::error::Error + 'static>(
    source: &std::path::Path,
    primary: E,
) -> Box<dyn std::error::Error> {
    let fence = reverie_host::worker_service::record_service_failure(source).err();
    Box::new(FencedFailure {
        primary: Box::new(primary),
        fence,
    })
}
#[derive(Debug)]
struct FencedFailure {
    primary: Box<dyn std::error::Error>,
    fence: Option<reverie_host::worker_service::WorkerServiceError>,
}
impl std::fmt::Display for FencedFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}; durable startup fence: {:?}",
            self.primary, self.fence
        )
    }
}
impl std::error::Error for FencedFailure {}
