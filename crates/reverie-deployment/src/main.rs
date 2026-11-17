use clap::{Parser, Subcommand};
use reverie_deployment::{DeploymentPreviewMode, DeploymentProfile, DeploymentService};
use std::{path::PathBuf, process::ExitCode};

#[derive(Parser)]
#[command(
    about = "Preview, prepare, apply or roll back the registered Reverie console release.",
    long_about = "Local owner bootstrap API for an existing ordinary Docker deployment. Reads the registered deployment.json and holds its existing update lock. It never changes the worker broker or bulk-wakes employees. Each effect attempt is durable and is never automatically retried. All output is structured JSON; private environment/configuration stays in the owner-only operation record.",
    after_long_help = "FLOW:\n  reverie-deployment --root ROOT preview --image sha256:IMAGE_ID\n  reverie-deployment --root ROOT prepare OPERATION\n  reverie-deployment --root ROOT apply OPERATION\n  reverie-deployment --root ROOT status OPERATION\n  reverie-deployment --root ROOT rollback OPERATION\n\nA prepared candidate has not started. Ordinary apply verifies a stopped-console snapshot and real extraction rehearsal before renaming anything. A live-account-writers-fix-forward plan retains an unverified live copy by default. Apply with --skip-backup to omit that copy for a prepared live-account plan. Code rollback compatibility is not guaranteed in either live mode. HYBRID_READY still requires the one-employee delivery/perf/restart acceptance. Rollback retains both containers and never automatically restores company data. A lost response requires status and inspection, not another submission."
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
        /// Preserve the original dynamic bridge network IDs and aliases.
        /// This does not waive the shared-writer or verified snapshot guard.
        #[arg(long)]
        preserve_network_grants: bool,
        /// Retain exact independently live account writers; accept an
        /// unverified copy and no guaranteed code/data rollback compatibility.
        #[arg(long, requires = "preserve_network_grants")]
        live_account_writers_fix_forward: bool,
        /// Explicit terminal stale claim; both old full CIDs must be absent.
        #[arg(long, requires = "expected_current_container")]
        adopt_stale_claim: Option<String>,
        /// Exact currently registered website full CID, independently verified.
        #[arg(long, requires = "adopt_stale_claim")]
        expected_current_container: Option<String>,
    },
    /// Create and inspect the candidate while the old console stays online.
    Prepare { operation: String },
    /// Reinspect a recorded sleeping candidate after a refused validation; never creates again.
    Confirm { operation: String },
    /// Retire only a historical v2 request proven invalid before Docker create.
    /// Never retries creation or recovers an arbitrary unknown request.
    RecoverInvalidCreate { operation: String },
    /// Owner fix-forward recovery: retain an ordinary data copy, without verified consistency.
    ActivateRetained {
        operation: String,
        /// Explicitly accept that the retained copy has not passed consistency checks.
        #[arg(long, required = true)]
        accept_unverified_backup: bool,
    },
    /// Stop, verify backup/rehearsal, swap and check the Rust-front process tree.
    Apply {
        operation: String,
        /// Activate a prepared live-account deployment without copying console data.
        #[arg(long)]
        skip_backup: bool,
    },
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
            Action::Preview {
                image,
                profile,
                preserve_network_grants,
                live_account_writers_fix_forward,
                adopt_stale_claim,
                expected_current_container,
            } => serde_json::to_value(if let Some(previous) = adopt_stale_claim {
                let mode = if live_account_writers_fix_forward {
                    DeploymentPreviewMode::LiveAccountsFixForward
                } else if preserve_network_grants {
                    DeploymentPreviewMode::PreserveNetworks
                } else {
                    DeploymentPreviewMode::Ordinary
                };
                service.preview_adopting_stale_claim(
                    &image,
                    profile,
                    mode,
                    &previous,
                    expected_current_container.as_deref().unwrap_or_default(),
                )?
            } else if live_account_writers_fix_forward {
                service.preview_live_accounts_fix_forward(&image, profile)?
            } else if preserve_network_grants {
                service.preview_preserving_networks(&image, profile)?
            } else {
                service.preview_with_profile(&image, profile)?
            })?,
            Action::Prepare { operation } => serde_json::to_value(service.prepare(&operation)?)?,
            Action::Confirm { operation } => serde_json::to_value(service.confirm(&operation)?)?,
            Action::RecoverInvalidCreate { operation } => {
                serde_json::to_value(service.recover_invalid_create(&operation)?)?
            }
            Action::ActivateRetained {
                operation,
                accept_unverified_backup: _,
            } => serde_json::to_value(service.activate_retained(&operation)?)?,
            Action::Apply {
                operation,
                skip_backup,
            } => serde_json::to_value(if skip_backup {
                service.apply_live_without_backup(&operation)?
            } else {
                service.apply(&operation)?
            })?,
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
    fn stale_claim_selection_requires_both_explicit_ids_and_default_stays_unchanged() {
        let image = format!("sha256:{}", "a".repeat(64));
        let base = [
            "reverie-deployment",
            "--root",
            "/fixture",
            "preview",
            "--image",
            &image,
        ];
        for flag in ["--adopt-stale-claim", "--expected-current-container"] {
            let mut args = base.to_vec();
            args.extend([flag, "selected"]);
            assert!(Arguments::try_parse_from(args).is_err());
        }
        let previous = "c".repeat(32);
        let current = "e".repeat(64);
        let mut args = base.to_vec();
        args.extend([
            "--adopt-stale-claim",
            &previous,
            "--expected-current-container",
            &current,
        ]);
        assert!(matches!(Arguments::try_parse_from(args).unwrap().action,
            Action::Preview {adopt_stale_claim:Some(op),expected_current_container:Some(cid),..} if op==previous && cid==current));
        assert!(matches!(
            Arguments::try_parse_from(base).unwrap().action,
            Action::Preview {
                adopt_stale_claim: None,
                expected_current_container: None,
                ..
            }
        ));
    }
    #[test]
    fn preserved_networks_are_an_explicit_preview_selection_not_a_raw_network_request() {
        let image = format!("sha256:{}", "a".repeat(64));
        let base = [
            "reverie-deployment",
            "--root",
            "/fixture",
            "preview",
            "--image",
            &image,
        ];
        let default = Arguments::try_parse_from(base).unwrap();
        assert!(matches!(
            default.action,
            Action::Preview {
                preserve_network_grants: false,
                ..
            }
        ));
        let mut selected = base.to_vec();
        selected.push("--preserve-network-grants");
        let parsed = Arguments::try_parse_from(selected).unwrap();
        assert!(matches!(
            parsed.action,
            Action::Preview {
                preserve_network_grants: true,
                ..
            }
        ));
        let mut arbitrary = base.to_vec();
        arbitrary.extend(["--networks", "request-selected"]);
        assert!(Arguments::try_parse_from(arbitrary).is_err());
    }
    #[test]
    fn live_account_disposition_requires_the_explicit_network_preservation_selection() {
        let image = format!("sha256:{}", "a".repeat(64));
        let base = [
            "reverie-deployment",
            "--root",
            "/fixture",
            "preview",
            "--image",
            &image,
        ];
        let mut unbound = base.to_vec();
        unbound.push("--live-account-writers-fix-forward");
        assert!(Arguments::try_parse_from(&unbound).is_err());
        unbound.push("--preserve-network-grants");
        assert!(matches!(
            Arguments::try_parse_from(unbound).unwrap().action,
            Action::Preview {
                preserve_network_grants: true,
                live_account_writers_fix_forward: true,
                ..
            }
        ));
        assert!(matches!(
            Arguments::try_parse_from(base).unwrap().action,
            Action::Preview {
                live_account_writers_fix_forward: false,
                ..
            }
        ));
    }
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
