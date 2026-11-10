use clap::{Parser, Subcommand};
use reverie_deployment::{DeploymentProfile, DeploymentService};
use std::{path::PathBuf, process::ExitCode};

#[derive(Parser)]
#[command(
    about = "Preview, prepare, apply or roll back the registered Reverie console release.",
    long_about = "Local owner bootstrap API for an existing ordinary Docker deployment. Reads the registered deployment.json and holds its existing update lock. It never changes the worker broker or bulk-wakes employees. Each effect attempt is durable and is never automatically retried. All output is structured JSON; private environment/configuration stays in the owner-only operation record.",
    after_long_help = "FLOW:\n  reverie-deployment --root ROOT preview --image sha256:IMAGE_ID\n  reverie-deployment --root ROOT prepare OPERATION\n  reverie-deployment --root ROOT apply OPERATION\n  reverie-deployment --root ROOT status OPERATION\n  reverie-deployment --root ROOT rollback OPERATION\n\nA prepared candidate has not started. Apply verifies a stopped-console snapshot and real extraction rehearsal before renaming anything. HYBRID_READY still requires the one-employee delivery/perf/restart acceptance. Rollback retains both containers and never automatically restores company data. A lost response requires status and inspection, not another submission."
)]
struct Arguments {
    /// Existing private installation root containing deployment.json.
    #[arg(long)]
    root: PathBuf,
    #[command(subcommand)]
    action: Action,
}
#[derive(Subcommand)]
enum Action {
    /// Freeze the exact old/candidate release and list environment default refreshes.
    Preview {
        #[arg(long)]
        image: String,
        /// Ordinary preserves the current profile. Protected website adds the
        /// fixed actor security profile without changing command or real binds.
        #[arg(long, value_enum, default_value_t = DeploymentProfile::Ordinary)]
        profile: DeploymentProfile,
    },
    /// Create and inspect the candidate while the old console stays online.
    Prepare { operation: String },
    /// Reinspect a recorded sleeping candidate after a refused validation; never creates again.
    Confirm { operation: String },
    /// Owner fix-forward recovery: retain an ordinary data copy, without verified consistency.
    ActivateRetained {
        operation: String,
        /// Explicitly accept that the retained copy has not passed consistency checks.
        #[arg(long, required = true)]
        accept_unverified_backup: bool,
    },
    /// Stop, verify backup/rehearsal, swap and check the Rust-front process tree.
    Apply { operation: String },
    /// Read durable operation status without replaying an effect.
    Status { operation: String },
    /// Return to the exact retained old console; preserve all data and containers.
    Rollback { operation: String },
}
fn main() -> ExitCode {
    let args = Arguments::parse();
    let result = run(args);
    match result {
        Ok(value) => {
            println!("{value}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            println!(
                "{}",
                serde_json::json!({"success":false,"code":error.code(),"finalizationCode":error.finalization_code(),"diagnostic":error.diagnostic(),
                "recovery":recovery_message(error.code())})
            );
            ExitCode::FAILURE
        }
    }
}
fn recovery_message(code: &str) -> &'static str {
    if code == "DEPLOYMENT_SHARED_WRITABLE_MOUNT" {
        "Another running container has a writable bind overlapping console data. Keep the current website running, coordinate authorized maintenance to quiesce that shared writer, then create a fresh verified deployment. Do not exclude account data or bypass backup verification."
    } else {
        "Inspect the durable operation and actual containers before another effect."
    }
}
fn run(args: Arguments) -> Result<serde_json::Value, reverie_deployment::DeploymentError> {
    let mut service = DeploymentService::capture(&args.root)?;
    let result: Result<serde_json::Value, reverie_deployment::DeploymentError> = (|| {
        let value = match args.action {
            Action::Preview { image, profile } => {
                serde_json::to_value(service.preview_with_profile(&image, profile)?)?
            }
            Action::Prepare { operation } => serde_json::to_value(service.prepare(&operation)?)?,
            Action::Confirm { operation } => serde_json::to_value(service.confirm(&operation)?)?,
            Action::ActivateRetained {
                operation,
                accept_unverified_backup: _,
            } => serde_json::to_value(service.activate_retained(&operation)?)?,
            Action::Apply { operation } => serde_json::to_value(service.apply(&operation)?)?,
            Action::Status { operation } => serde_json::to_value(service.status(&operation)?)?,
            Action::Rollback { operation } => serde_json::to_value(service.rollback(&operation)?)?,
        };
        Ok(value)
    })();
    finish(result, service.close())
}
fn finish(
    result: Result<serde_json::Value, reverie_deployment::DeploymentError>,
    closed: Result<(), reverie_deployment::DeploymentError>,
) -> Result<serde_json::Value, reverie_deployment::DeploymentError> {
    let value = reverie_deployment::DeploymentError::finalized(result, closed)?;
    Ok(serde_json::json!({"success":true,"data":value}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn body_and_close_errors_both_survive_cli_finalization() {
        let body = serde_json::from_slice::<serde_json::Value>(b"invalid")
            .unwrap_err()
            .into();
        let closed = std::io::Error::other("owned fixture close failure").into();
        let error = finish(Err(body), Err(closed)).unwrap_err();
        assert_eq!(error.code(), "DEPLOYMENT_JSON_INVALID");
        assert_eq!(error.finalization_code(), Some("DEPLOYMENT_IO_UNAVAILABLE"));
    }
}
