//! Explicit owner-local import. Request bytes are the existing closed OS
//! nomination DATA, never a runtime file destination or execution permission.
use clap::Subcommand;
use std::{
    path::PathBuf,
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
}
pub(super) fn run(action: Action) -> Result<(), Box<dyn std::error::Error>> {
    match action {
        Action::NominateV1 { config, request } => {
            let end = Instant::now() + Duration::from_secs(30);
            let snapshot = super::load_owner_config(&config)?;
            let runtime =
                super::WorkerRuntime::new(super::captured_engine()?, snapshot.envelope().base());
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
