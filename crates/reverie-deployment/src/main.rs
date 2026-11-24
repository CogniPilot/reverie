use clap::{Parser, Subcommand};
use reverie_deployment::{
    DeploymentPreviewMode, DeploymentProfile, DeploymentService, SourceRestore,
};
use std::{path::PathBuf, process::ExitCode};

#[derive(Parser)]
#[command(
    about = "Preview, prepare, apply or roll back the registered Reverie console release.",
    long_about = "Local owner bootstrap API for an existing ordinary Docker deployment. Reads the registered deployment.json and holds its existing update lock. It never changes the worker broker or bulk-wakes employees. Each effect attempt is durable and is never automatically retried. All output is structured JSON; private environment/configuration stays in the owner-only operation record.",
    after_long_help = "FLOW:\n  reverie-deployment --root ROOT preview --image sha256:IMAGE_ID\n  reverie-deployment --root ROOT prepare OPERATION\n  reverie-deployment --root ROOT apply OPERATION\n  reverie-deployment --root ROOT status OPERATION\n  reverie-deployment --root ROOT rollback OPERATION\n\nA prepared candidate has not started. Ordinary apply verifies a stopped-console snapshot and real extraction rehearsal before renaming anything. A live-account-writers-fix-forward plan retains an unverified live copy by default. Apply with --skip-backup to omit that copy for a prepared live-account plan. Code rollback compatibility is not guaranteed in either live mode. HYBRID_READY still requires the one-employee delivery/perf/restart acceptance. Rollback retains both containers and never automatically restores company data. A lost response requires status and inspection, not another submission. When apply fails after stopping the office and before the new console has ever started, it starts the original office again and reports both the failure and the restore; if that restore is not proven, the output names the one rollback command to run."
)]
struct Arguments {
    /// Existing private installation root containing deployment.json.
    #[arg(long)]
    root: PathBuf,
    #[command(subcommand)]
    action: Command,
}
#[derive(Subcommand)]
enum Command {
    /// Read durable operation status, including while Docker is unavailable.
    Status {
        /// Operation ID. Omit to inspect the operation holding the registered deployment claim.
        operation: Option<String>,
    },
    #[command(flatten)]
    Online(Action),
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
        /// Stop the unchanged running source after checking the prepared candidate and bind grants.
        #[arg(long)]
        stop_running_source: bool,
    },
    /// Stop, verify backup/rehearsal, swap and check the Rust-front process tree.
    #[command(
        long_about = "Stop the office, capture and verify its console data, rehearse the restore, then swap to the prepared console and check it. The rehearsal directory, the backup destination and the free space for both copies are checked before the office is stopped. If anything fails after the stop and before the new console has ever started, the original office is started again and the output reports both results."
    )]
    Apply {
        operation: String,
        /// Activate a prepared live-account deployment without copying console data.
        #[arg(long)]
        skip_backup: bool,
        /// Existing empty directory you own with mode 0700, for the extracted restore test.
        #[arg(long, conflicts_with = "skip_backup")]
        rehearsal_root: Option<PathBuf>,
        /// Keep a verified gzip archive in the operation and stage the raw tar on the rehearsal disk.
        #[arg(long, requires = "rehearsal_root")]
        compress_backup: bool,
    },
    /// Report whether a verified update's backup would fit; change nothing.
    #[command(
        long_about = "Measure the running office's console data and report the space the archive and the restore rehearsal need against what is free, using the same checks apply runs before it stops the office. Give the same --rehearsal-root and --compress-backup you intend to pass to apply. Nothing is prepared, stopped or written."
    )]
    CheckStorage {
        /// Existing empty directory you own with mode 0700, for the extracted restore test.
        #[arg(long)]
        rehearsal_root: Option<PathBuf>,
        /// Stage the raw tar on the rehearsal disk as apply --compress-backup would.
        #[arg(long, requires = "rehearsal_root")]
        compress_backup: bool,
    },
    /// Report or remove the backups of closed, superseded updates.
    #[command(
        long_about = "Report the backups and restore-rehearsal copies that earlier updates left behind. With --apply, remove those of operations that ended ready, restored or refused and whose claim a later operation took over. The active operation and the --keep most recent operations holding storage are always kept. Only directories this tool created and journaled are removed, never anything found by name; operation journals and containers are kept. A rehearsal copy made before this command existed was not journaled and is not removed."
    )]
    PruneDeployments {
        /// Permanently remove the listed backups. Without this, report only.
        #[arg(long)]
        apply: bool,
        /// Operations holding storage to keep, counting the active one.
        #[arg(long, default_value_t = 2)]
        keep: u16,
    },
    /// Report or clear the contents of this office's employee /tmp mounts.
    #[command(
        long_about = "Report allocated bytes in the registered office's employee /tmp trees. With --apply, clear disposable entries after the office and overlapping Docker containers are stopped. Keep the mount directories. Stop host jobs that use these trees before applying."
    )]
    PruneScratch {
        /// Permanently remove disposable contents. Without this, report only.
        #[arg(long)]
        apply: bool,
        /// Include owned read-only directories in the preview or cleanup.
        #[arg(long)]
        force_read_only: bool,
        /// Include an additional host task-lease directory in the apply guard.
        #[arg(long = "lease-dir", requires = "apply")]
        lease_dirs: Vec<PathBuf>,
    },
    /// Report or clear aged Cargo build caches on the company workspace disk.
    PruneWorkspace {
        /// Remove old verified caches after the office and their Docker users stop.
        #[arg(long)]
        apply: bool,
        /// Keep build caches with newer file or directory changes.
        #[arg(long, default_value_t = 4)]
        min_age_days: u16,
        /// Include an additional host task-lease directory in the apply guard.
        #[arg(long = "lease-dir", requires = "apply")]
        lease_dirs: Vec<PathBuf>,
    },
    /// Return to the exact retained old console; preserve all data and containers.
    Rollback { operation: String },
}
fn main() -> ExitCode {
    let args = Arguments::parse();
    let storage = matches!(
        args.action,
        Command::Online(
            Action::PruneScratch { .. }
                | Action::PruneWorkspace { .. }
                | Action::PruneDeployments { .. }
        )
    );
    let rollback = rollback_command(&args);
    let result = run(args);
    match result {
        Ok(mut value) => {
            let refused = storage && value["data"]["success"] == false;
            if refused {
                value["success"] = serde_json::Value::Bool(false);
            }
            println!("{value}");
            if refused {
                ExitCode::FAILURE
            } else {
                ExitCode::SUCCESS
            }
        }
        Err(error) => {
            println!("{}", failure_report(&error, rollback.as_deref()));
            ExitCode::FAILURE
        }
    }
}
/// The one command that returns to the original console, or records that
/// return once it is observed. Shown as arguments so no quoting is implied.
fn rollback_command(args: &Arguments) -> Option<Vec<String>> {
    let operation = match &args.action {
        Command::Online(
            Action::Apply { operation, .. }
            | Action::ActivateRetained { operation, .. }
            | Action::Rollback { operation },
        ) => operation,
        Command::Status {
            operation: Some(operation),
        } => operation,
        _ => return None,
    };
    Some(rollback_arguments(&args.root, operation))
}
fn rollback_arguments(root: &std::path::Path, operation: &str) -> Vec<String> {
    vec![
        "reverie-deployment".into(),
        "--root".into(),
        root.display().to_string(),
        "rollback".into(),
        operation.into(),
    ]
}
fn failure_report(
    error: &reverie_deployment::DeploymentError,
    rollback: Option<&[String]>,
) -> serde_json::Value {
    let mut report = serde_json::json!({"success":false,"code":error.code(),"finalizationCode":error.finalization_code(),"diagnostic":error.diagnostic(),
        "detail":error.detail(),"recovery":recovery_message(error.code())});
    if let Some(restore) = error.source_restore() {
        report["sourceRestore"] = restore.report();
        report["recovery"] = restore_message(restore).into();
        if !matches!(restore, SourceRestore::Restored) {
            report["sourceRestore"]["command"] = serde_json::json!(rollback);
        }
    }
    report
}
fn restore_message(restore: &SourceRestore) -> &'static str {
    match restore {
        SourceRestore::Restored => {
            "The update was not applied. The original office was started again automatically and answered its readiness check. This operation is closed: fix the reported cause, then begin a new preview."
        }
        SourceRestore::NotAttempted(_) => {
            "The update was not applied and the original office was NOT restarted automatically; it may be stopped. sourceRestore.code says why. Check status, then run sourceRestore.command to return to the original office."
        }
        SourceRestore::Unproven(_) => {
            "The update was not applied. An automatic restart of the original office was attempted and is NOT proven; the office may be stopped. Check status and the containers. sourceRestore.command repeats no effect: it records the restore once the original console is observed running and ready."
        }
    }
}
/// What an interrupted operation needs next, for a status read after the
/// process that ran the update is gone.
fn status_recovery(stage: &str) -> Option<&'static str> {
    match stage {
        "STOP_UNCONFIRMED" | "SNAPSHOT_VERIFIED" | "SWAP_UNCONFIRMED" => Some(
            "This update stopped the original office and did not finish. Run the rollback command to start the original office again.",
        ),
        "START_UNCONFIRMED" => Some(
            "The new console was started and is not confirmed ready. Inspect it first. The rollback command returns to the original console, which may not read data the new console wrote.",
        ),
        "ROLLBACK_UNCONFIRMED" => Some(
            "A return to the original console was attempted and is not proven. The rollback command repeats no effect: it records the restore once the original console is observed running and ready.",
        ),
        _ => None,
    }
}
fn status_report(
    root: &std::path::Path,
    status: reverie_deployment::DeploymentStatus,
) -> Result<serde_json::Value, reverie_deployment::DeploymentError> {
    let recovery = status_recovery(&status.stage);
    let command = recovery.map(|_| rollback_arguments(root, &status.operation));
    let mut report = serde_json::json!({"success":true,"data":status});
    if let Some(recovery) = recovery {
        report["recovery"] = recovery.into();
        report["rollbackCommand"] = serde_json::to_value(command)?;
    }
    Ok(report)
}
fn recovery_message(code: &str) -> &'static str {
    match code {
        "DEPLOYMENT_NO_ACTIVE_OPERATION" => {
            "No operation holds the registered claim. For a preview, supply its operation ID to status."
        }
        "DEPLOYMENT_SHARED_WRITABLE_MOUNT" => {
            "Another running container has a writable bind overlapping console data. Keep the current website running, coordinate authorized maintenance to quiesce that shared writer, then create a fresh verified deployment. Do not exclude account data or bypass backup verification."
        }
        "DEPLOYMENT_REHEARSAL_ROOT_REFUSED" => {
            "Nothing was stopped. The rehearsal root must already exist as an empty directory that you own with mode 0700, given as an absolute path with no symbolic link in it, outside the console data and the operation directory. Any name is accepted. diagnostic.error.snapshot.code says which of these failed."
        }
        "DEPLOYMENT_BACKUP_SPACE_INSUFFICIENT" => {
            "Nothing was stopped. detail.filesystems lists the bytes each filesystem needs for the archive and the restore rehearsal against the bytes free. Free space, for example with prune-deployments, or pass --rehearsal-root on another disk."
        }
        "DEPLOYMENT_BACKUP_ESTIMATE_REFUSED" | "DEPLOYMENT_SNAPSHOT_OCCUPIED" => {
            "Nothing was stopped. The backup could not be planned; diagnostic.error names the check that refused."
        }
        "SCRATCH_LEASE_IN_USE" => {
            "Finish the task or wait for its reservation to expire before clearing scratch."
        }
        "SCRATCH_LEASE_INVENTORY_UNCONFIRMED" => {
            "Check the office and worker lease directories and include any additional host lease directories."
        }
        "SCRATCH_FINALIZATION_UNCONFIRMED" => {
            "Run a fresh scratch preview to inspect what remains before starting the office."
        }
        _ => "Inspect the durable operation and actual containers before another effect.",
    }
}
fn run(args: Arguments) -> Result<serde_json::Value, reverie_deployment::DeploymentError> {
    let action = match args.action {
        Command::Status { operation } => {
            let status = match operation {
                Some(id) => DeploymentService::registered_status(&args.root, &id)?,
                None => DeploymentService::registered_active_status(&args.root)?,
            };
            return status_report(&args.root, status);
        }
        Command::Online(action) => action,
    };
    let mut service = DeploymentService::capture(&args.root)?;
    let result: Result<serde_json::Value, reverie_deployment::DeploymentError> = (|| {
        let value = match action {
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
                stop_running_source,
            } => serde_json::to_value(if stop_running_source {
                service.activate_retained_from_running(&operation)?
            } else {
                service.activate_retained(&operation)?
            })?,
            Action::Apply {
                operation,
                skip_backup,
                rehearsal_root,
                compress_backup,
            } => serde_json::to_value(if skip_backup {
                service.apply_live_without_backup(&operation)?
            } else if let Some(root) = rehearsal_root {
                if compress_backup {
                    service.apply_with_compressed_backup(&operation, &root)?
                } else {
                    service.apply_with_rehearsal_root(&operation, &root)?
                }
            } else {
                service.apply(&operation)?
            })?,
            Action::CheckStorage {
                rehearsal_root,
                compress_backup,
            } => service.check_backup_storage(rehearsal_root.as_deref(), compress_backup)?,
            Action::PruneDeployments { apply, keep } => {
                service.prune_deployments(apply, usize::from(keep))?
            }
            Action::PruneScratch {
                apply,
                force_read_only,
                lease_dirs,
            } => service.prune_scratch(apply, force_read_only, &lease_dirs)?,
            Action::PruneWorkspace {
                apply,
                min_age_days,
                lease_dirs,
            } => service.prune_workspace(apply, min_age_days, &lease_dirs)?,
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
    fn stopping_the_source_for_a_retained_copy_requires_explicit_backup_acceptance() {
        let args = [
            "reverie-deployment",
            "--root",
            "/fixture",
            "activate-retained",
            "selected",
            "--stop-running-source",
        ];
        assert!(Arguments::try_parse_from(args).is_err());
        let mut accepted = args.to_vec();
        accepted.push("--accept-unverified-backup");
        assert!(matches!(
            Arguments::try_parse_from(accepted).unwrap().action,
            Command::Online(Action::ActivateRetained {
                stop_running_source: true,
                accept_unverified_backup: true,
                ..
            })
        ));
    }
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
            Command::Online(Action::Preview {adopt_stale_claim:Some(op),expected_current_container:Some(cid),..}) if op==previous && cid==current));
        assert!(matches!(
            Arguments::try_parse_from(base).unwrap().action,
            Command::Online(Action::Preview {
                adopt_stale_claim: None,
                expected_current_container: None,
                ..
            })
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
            Command::Online(Action::Preview {
                preserve_network_grants: false,
                ..
            })
        ));
        let mut selected = base.to_vec();
        selected.push("--preserve-network-grants");
        let parsed = Arguments::try_parse_from(selected).unwrap();
        assert!(matches!(
            parsed.action,
            Command::Online(Action::Preview {
                preserve_network_grants: true,
                ..
            })
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
            Command::Online(Action::Preview {
                preserve_network_grants: true,
                live_account_writers_fix_forward: true,
                ..
            })
        ));
        assert!(matches!(
            Arguments::try_parse_from(base).unwrap().action,
            Command::Online(Action::Preview {
                live_account_writers_fix_forward: false,
                ..
            })
        ));
    }
    #[test]
    fn an_interrupted_status_names_the_one_rollback_command() {
        let status = |stage: &str| reverie_deployment::DeploymentStatus {
            operation: "c".repeat(32),
            stage: stage.into(),
            candidate_id: None,
            source_id: "a".repeat(64),
            backup_verified: None,
            diagnostic: None,
            automatic_restore: None,
            readiness_failure: None,
        };
        let root = std::path::Path::new("/office root");
        for stage in [
            "STOP_UNCONFIRMED",
            "SNAPSHOT_VERIFIED",
            "SWAP_UNCONFIRMED",
            "START_UNCONFIRMED",
            "ROLLBACK_UNCONFIRMED",
        ] {
            let report = status_report(root, status(stage)).unwrap();
            assert_eq!(
                report["rollbackCommand"],
                serde_json::json!([
                    "reverie-deployment",
                    "--root",
                    "/office root",
                    "rollback",
                    "c".repeat(32)
                ]),
                "{stage}"
            );
            assert!(report["recovery"].is_string(), "{stage}");
            assert_eq!(report["data"]["stage"], stage);
        }
        for stage in ["PREPARED", "HYBRID_READY", "RESTORED", "SUPERSEDED"] {
            let report = status_report(root, status(stage)).unwrap();
            assert!(report.get("recovery").is_none(), "{stage}");
            assert!(report.get("rollbackCommand").is_none(), "{stage}");
        }
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
