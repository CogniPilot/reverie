//! Thin initial whole-rollout adapter. No subprocess or private state bridging.
use super::*;
use clap::Args;
use std::time::{Duration, Instant};
#[derive(Args)]
pub(super) struct Selection {
    /// Existing registered owner worker configuration.
    #[arg(long, value_name = "FILE")]
    config: PathBuf,
    /// Existing private installation root containing deployment.json.
    #[arg(long, value_name = "DIRECTORY")]
    root: PathBuf,
    /// Already-loaded immutable qualified website image ID (sha256:...).
    #[arg(long, value_name = "SHA256:IMAGE_ID")]
    image: String,
}
#[derive(Subcommand)]
pub(super) enum Action {
    /// Update an already selected actor with the actual new website facts.
    /// Requires an uninstalled pool and an inactive broker; leaves employees stopped.
    UpdateUninstalled {
        #[command(flatten)]
        selection: Selection,
        /// Explicitly skip backup creation, as selected by the owner.
        #[arg(long)]
        skip_backup: bool,
    },
    /// INITIAL setup only: quiesce the registered broker/workers, verify a
    /// complete backup/rehearsal, deploy the protected website, and install its
    /// fixed actor facts under the SAME service fence. Refuses an existing
    /// actor selector. Leaves broker/workers stopped; no pool consent/start or
    /// automatic rollback/retry occurs. Inspect reported OP after a lost reply.
    Rollout {
        #[command(flatten)]
        selection: Selection,
    },
}
pub(super) fn run(action: Action) -> Result<(), Box<dyn std::error::Error>> {
    let (selection, update, skip_backup) = match action {
        Action::Rollout { selection } => (selection, false, false),
        Action::UpdateUninstalled {
            selection,
            skip_backup,
        } => (selection, true, skip_backup),
    };
    let end = Instant::now() + Duration::from_secs(900);
    let broker = super::offline_owner::capture(&selection.config)?;
    let outcome = if update {
        reverie_deployment::update_uninstalled_website(
            broker,
            &selection.root,
            &selection.config,
            &selection.image,
            end,
            skip_backup,
        )
    } else {
        reverie_deployment::rollout_initial_website(
            broker,
            &selection.root,
            &selection.config,
            &selection.image,
            end,
        )
    };
    match outcome {
        Ok(closed) => {
            println!(
                "{}",
                serde_json::json!({"phase":if update {"protected-website-actor-refreshed"} else {"initial-protected-website-actor-installed"},"operationId":closed.operation_id(),"deployment":closed.deployment_status(),"configurationDigest":closed.actor_configuration_digest(),"actorPreviewDigest":closed.actor_preview_digest(),"workerBrokerStarted":false,"workersRestored":false,"poolConsentGranted":false})
            );
            Ok(())
        }
        Err(failure) => {
            eprintln!(
                "{}",
                serde_json::json!({"phase":if update {"website-update-unconfirmed"} else {"initial-website-rollout-unconfirmed"},"operationId":failure.operation_id(),"deploymentOperation":failure.deployment_operation(),"code":failure.cause().code(),"automaticRetry":false})
            );
            Err(failure)
        }
    }
}
