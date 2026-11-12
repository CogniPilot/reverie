//! Thin owner CLI over the checked initial website actor setup operation.
use super::offline_owner::finalized;
use super::*;
use clap::Args;
use reverie_core::operations::{JournalDigest, JournalId};
use reverie_host::worker_service::capture_stopped_worker_service;
use std::time::{Duration, Instant};

#[derive(Args)]
pub(super) struct Selection {
    /// Existing registered owner configuration beneath ~/reverie.
    #[arg(long, value_name = "FILE")]
    config: PathBuf,
}

#[derive(Subcommand)]
pub(super) enum Action {
    /// Observe the actual website using the fixed packaged provenance and
    /// obtain a preview digest. No identity or configuration is installed.
    Preview {
        #[command(flatten)]
        selection: Selection,
    },
    /// Install exactly the previewed actor/configuration transition while
    /// the registered native service is inactive; employee policies are kept.
    Apply {
        #[command(flatten)]
        selection: Selection,
        /// Exact digest from a fresh preview; a mismatch grants no consent.
        #[arg(long, value_name = "SHA256")]
        expected_preview: String,
        /// Fresh canonical nonnil UUID. Inspect a lost result before retrying.
        #[arg(long, value_name = "UUID")]
        operation_id: String,
    },
}

pub(super) fn run(action: Action) -> Result<(), Box<dyn std::error::Error>> {
    let (selection, apply) = match action {
        Action::Preview { selection } => (selection, None),
        Action::Apply {
            selection,
            expected_preview,
            operation_id,
        } => (
            selection,
            Some((
                JournalDigest::parse(&expected_preview)?,
                JournalId::parse(&operation_id)?,
            )),
        ),
    };
    let end = Instant::now() + Duration::from_secs(300);
    let broker = super::offline_owner::capture(&selection.config)?;
    let mut prepared = broker.prepare_offline_actor_setup(end)?;
    let preview = prepared.preview_digest().as_str().to_owned();
    let configuration = prepared.configuration_digest().as_str().to_owned();
    if let Some((expected, operation)) = apply {
        if prepared.preview_digest() != &expected {
            return Err(finalized(
                "NATIVE_ACTOR_PREVIEW_CHANGED".into(),
                prepared
                    .close(end)
                    .err()
                    .map(|error| error as Box<dyn std::error::Error>),
            ));
        }
        prepared = prepared.assert_current(end)?;
        let service = (|| -> Result<_, Box<dyn std::error::Error>> {
            Ok(capture_stopped_worker_service(&selection.config, end)?.begin_image_transition()?)
        })();
        let service = match service {
            Ok(service) => service,
            Err(primary) => {
                return Err(finalized(
                    primary,
                    prepared
                        .close(end)
                        .err()
                        .map(|error| error as Box<dyn std::error::Error>),
                ));
            }
        };
        let closed = prepared.apply(service, &expected, &operation)?;
        println!(
            "{}",
            serde_json::json!({"applied":true,"actorInstalled":true,
            "previewDigest":closed.preview_digest().as_str(),
            "configurationDigest":closed.configuration_digest().as_str(),
            "started":false,"fleetRecreated":false})
        );
    } else {
        prepared.close(end)?;
        println!(
            "{}",
            serde_json::json!({"applied":false,"actorInstalled":false,
            "previewDigest":preview,"configurationDigest":configuration,
            "started":false,"fleetRecreated":false})
        );
    }
    Ok(())
}
