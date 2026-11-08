//! Thin ordinary-owner bootstrap adapter. The application owns every decision.
use super::*;
use clap::Args;
use reverie_contracts::{resource_actor::ArtifactReference, worker_image_switch::WorkerImageId};
use reverie_core::{
    PythonText,
    operations::{JournalDigest, JournalId},
};
use reverie_host::worker_service::capture_stopped_worker_service;
use std::{
    path::Path,
    time::{Duration, Instant},
};

#[derive(Args)]
pub(super) struct Selection {
    /// Existing registered owner configuration under ~/reverie.
    #[arg(long, value_name = "FILE")]
    config: PathBuf,
    /// Immutable worker-image-provenance-v1 JSON from the Nix image factory.
    #[arg(long, value_name = "NIX_FILE")]
    provenance: PathBuf,
    /// Exact SHA-256 of the original provenance file bytes.
    #[arg(long, value_name = "SHA256")]
    provenance_sha256: String,
    /// Immutable worker-child-image-v1 annex from the same image factory.
    #[arg(long, value_name = "NIX_FILE")]
    child_annex: PathBuf,
    /// Exact SHA-256 of the original child annex bytes.
    #[arg(long, value_name = "SHA256")]
    child_annex_sha256: String,
    /// Exact already-loaded Docker image ID, including sha256: prefix.
    #[arg(long, value_name = "IMAGE_ID")]
    image: String,
}
#[derive(Subcommand)]
pub(super) enum Action {
    /// Read and qualify the loaded image and current stopped-worker preview.
    /// Opens no service IMAGE fence and changes no configuration.
    Preview {
        #[command(flatten)]
        selection: Selection,
    },
    /// Apply only the checked image pin while the registered native unit is
    /// inactive and every scoped worker is physically stopped.
    Apply {
        #[command(flatten)]
        selection: Selection,
        /// Exact digest returned by a fresh preview. A mismatch is no consent.
        #[arg(long, value_name = "SHA256")]
        expected_preview: String,
        /// Fresh canonical nonnil operation UUID; never retry an unknown result.
        #[arg(long, value_name = "UUID")]
        operation_id: String,
    },
}
enum Request {
    Preview,
    Apply {
        preview: JournalDigest,
        operation: JournalId,
    },
}
fn artifact(path: &Path, digest: &str) -> Result<ArtifactReference, Box<dyn std::error::Error>> {
    Ok(ArtifactReference {
        path: PythonText::from_scalar_text(path.to_str().ok_or("NATIVE_IMAGE_ARTIFACT_PATH_UTF8")?),
        sha256: JournalDigest::parse(digest)?,
    })
}
fn installing_owner(
    config: &Path,
) -> Result<&'static InstallingBroker, Box<dyn std::error::Error>> {
    let snapshot = load_owner_config(config)?;
    let runtime = WorkerRuntime::new(super::captured_engine()?, snapshot.envelope().base());
    let broker = InstallingBroker::new(snapshot, runtime)?;
    // One-shot CLI scope: borrowed failure owners must keep their original
    // installing instance at a stable address until process termination.
    // Successful component closure is explicit in close/apply, not Drop.
    Ok(Box::leak(Box::new(broker)))
}
pub(super) fn run(action: Action) -> Result<(), Box<dyn std::error::Error>> {
    let (selection, request) = match action {
        Action::Preview { selection } => (selection, Request::Preview),
        Action::Apply {
            selection,
            expected_preview,
            operation_id,
        } => (
            selection,
            Request::Apply {
                preview: JournalDigest::parse(&expected_preview)?,
                operation: JournalId::parse(&operation_id)?,
            },
        ),
    };
    let base = artifact(&selection.provenance, &selection.provenance_sha256)?;
    let annex = artifact(&selection.child_annex, &selection.child_annex_sha256)?;
    let image = WorkerImageId::parse(&selection.image)?;
    let end = Instant::now() + Duration::from_secs(300);
    let broker = installing_owner(&selection.config)?;
    let qualified = broker.qualify_worker_image(base, annex, image, end)?;
    let mut prepared = qualified.prepare_offline_switch()?;
    match request {
        Request::Preview => {
            let digest = prepared.preview_digest().as_str().to_owned();
            let image = prepared.image().as_str().to_owned();
            prepared.close(end)?;
            println!(
                "{}",
                serde_json::json!({"previewDigest":digest,"image":image,
                "applied":false,"started":false,"fleetRecreated":false})
            );
        }
        Request::Apply { preview, operation } => {
            if prepared.preview_digest() != &preview {
                prepared.close(end)?;
                return Err("NATIVE_IMAGE_PREVIEW_CHANGED".into());
            }
            prepared.assert_current(end)?;
            let service =
                capture_stopped_worker_service(&selection.config, end)?.begin_image_transition()?;
            let closed = prepared.apply(service, &preview, operation)?;
            println!(
                "{}",
                serde_json::json!({"applied":true,
                "oldImage":closed.old_image().as_str(),"newImage":closed.new_image().as_str(),
                "previewDigest":closed.preview_digest().as_str(),
                "configurationDigest":closed.configuration_digest().as_str(),
                "source":closed.source().display().to_string(),
                "serviceGeneration":closed.service_generation().display().to_string(),
                "started":false,"fleetRecreated":false})
            );
        }
    }
    Ok(())
}
