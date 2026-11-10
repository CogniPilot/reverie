//! Explicit owner-local import. Request bytes are the existing closed OS
//! nomination DATA, never a runtime file destination or execution permission.
use clap::Subcommand;
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
#[derive(Subcommand)]
pub(super) enum Action {
    /// Import the closed OS nomination. Principal must be the explicit
    /// enrollment response; both loaded images must match packaged inputs.
    /// Refuses any existing fixed request; never overwrites or restarts.
    NominateV1 {
        #[arg(long)]
        config: PathBuf,
        #[arg(long, value_name = "FILE")]
        request: PathBuf,
    },
    /// Derive and exclusively publish a PROPOSED nomination from current
    /// configuration/native facts and the legitimate enrollment response.
    /// No caller policy, image, CPU mask, account mutation or consent is accepted.
    PrepareNominationV1 {
        #[arg(long)]
        config: PathBuf,
        #[arg(long, value_name = "FILE")]
        enrollment: PathBuf,
    },
}
pub(super) fn run(action: Action) -> Result<(), Box<dyn std::error::Error>> {
    match action {
        Action::PrepareNominationV1 { config, enrollment } => {
            let end = Instant::now() + Duration::from_secs(30);
            let (snapshot, runtime) = capture(&config)?;
            let published =
                reverie_application::installing_broker::nominate_current_os_worker_pool(
                    &snapshot,
                    runtime,
                    &enrollment,
                    end,
                )?;
            let request: serde_json::Value = serde_json::from_slice(published.canonical_request())?;
            println!(
                "{}",
                serde_json::json!({"nominationPublished":true,"path":published.path(),
                "requestDigest":published.request_digest(),"proposedNomination":request,
                "proposedSoftHighFromCurrentHard":published.proposed_from_hard(),
                "cpuWeightBasis":"proposed-default-100","requiresExplicitMaintenanceConsent":true})
            );
            Ok(())
        }
        Action::NominateV1 { config, request } => {
            let end = Instant::now() + Duration::from_secs(30);
            let (snapshot, runtime) = capture(&config)?;
            let published = reverie_application::installing_broker::nominate_os_worker_pool(
                &snapshot, runtime, &request, end,
            )?;
            println!(
                "{}",
                serde_json::json!({"nominationPublished":true,"path":published.path(),
                "requestDigest":published.request_digest()})
            );
            Ok(())
        }
    }
}
fn capture(
    config: &Path,
) -> Result<
    (
        reverie_application::worker_validation::ValidatedWorkerSnapshot,
        super::WorkerRuntime,
    ),
    Box<dyn std::error::Error>,
> {
    let snapshot = super::load_owner_config(config)?;
    let runtime = super::WorkerRuntime::new(super::captured_engine()?, snapshot.envelope().base());
    Ok((snapshot, runtime))
}
