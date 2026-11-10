//! Explicit owner-local import. Request bytes are the existing closed OS
//! nomination DATA, never a runtime file destination or execution permission.
use clap::Subcommand;
use reverie_core::{ids::ProfileEmployeeId, operations::JournalDigest};
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
#[derive(Subcommand)]
pub(super) enum Action {
    /// Preserve the denial record from one uninstalled failed pool as UNKNOWN.
    /// Requires actual stopped service/R/IMAGE/native absence; starts nothing.
    RecoverUninstalledPendingV1 {
        #[arg(long)]
        config: PathBuf,
        #[arg(long)]
        expected_request_digest: String,
        #[arg(long)]
        expected_pending_digest: String,
    },
    /// Observe the current protected website and rebase only an uninstalled
    /// proposal; no controller, worker, policy activation or consent is started.
    RebaseUninstalledNominationV1 {
        #[arg(long)]
        config: PathBuf,
        #[arg(long)]
        expected_request_digest: String,
    },
    /// Preserve one failed pre-serving controller and its original evidence,
    /// then derive a new fixed-image proposal. No activation or worker start.
    RetireFailedInstallationV1 {
        #[arg(long)]
        config: PathBuf,
        #[arg(long)]
        expected_request_digest: String,
    },
    /// Revise only proposed soft thresholds under the original stopped Offer
    /// service. Preserves the old inode; never grants activation or wakes staff.
    ReviseNominationV1 {
        #[arg(long)]
        config: PathBuf,
        #[arg(long)]
        expected_request_digest: String,
        #[arg(long)]
        default_high_mib: u32,
        #[arg(long = "employee-high", value_parser = employee_high)]
        employee_high: Vec<(ProfileEmployeeId, u32)>,
    },
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
        Action::RecoverUninstalledPendingV1 {
            config,
            expected_request_digest,
            expected_pending_digest,
        } => {
            let expected = JournalDigest::parse(&expected_request_digest)?;
            let pending = JournalDigest::parse(&expected_pending_digest)?;
            let (snapshot, runtime) = capture(&config)?;
            let result =
                reverie_application::installing_broker::recover_uninstalled_os_worker_pool_pending(
                    &snapshot,
                    runtime,
                    &expected,
                    &pending,
                    Instant::now() + Duration::from_secs(30),
                )?;
            println!(
                "{}",
                serde_json::json!({"pendingArchivedAsUnconfirmed":true,"priorOutcome":"unconfirmed",
                "requestDigest":result.request_digest(),"requiresFreshOffer":true,
                "requiresExplicitMaintenanceConsent":true,"started":false})
            );
            Ok(())
        }
        Action::RebaseUninstalledNominationV1 {
            config,
            expected_request_digest,
        } => {
            let expected = JournalDigest::parse(&expected_request_digest)?;
            let (snapshot, runtime) = capture(&config)?;
            let result = reverie_application::installing_broker::rebase_uninstalled_os_worker_pool_nomination(
                &snapshot, runtime, &expected, Instant::now() + Duration::from_secs(30),
            )?;
            println!(
                "{}",
                serde_json::json!({"nominationRebased":true,"requestDigest":result.request_digest(),
                "requiresFreshOffer":true,"requiresExplicitMaintenanceConsent":true,"started":false})
            );
            Ok(())
        }
        Action::RetireFailedInstallationV1 {
            config,
            expected_request_digest,
        } => retire_failed_installation(&config, &expected_request_digest),
        Action::ReviseNominationV1 {
            config,
            expected_request_digest,
            default_high_mib,
            employee_high,
        } => revise_nomination(
            &config,
            &expected_request_digest,
            default_high_mib,
            employee_high,
        ),
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
fn retire_failed_installation(
    config: &Path,
    expected_request_digest: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let expected = JournalDigest::parse(expected_request_digest)?;
    let (snapshot, runtime) = capture(config)?;
    let result = reverie_application::installing_broker::retire_failed_os_worker_pool_installation(
        &snapshot,
        runtime,
        &expected,
        Instant::now() + Duration::from_secs(30),
    )?;
    let request: serde_json::Value = serde_json::from_slice(result.canonical_request())?;
    println!(
        "{}",
        serde_json::json!({"failedInstallationRetired":true,
        "originalActivationCompleted":false,"nominationRevised":true,
        "path":result.path(),"requestDigest":result.request_digest(),"proposedNomination":request,
        "requiresFreshOffer":true,"requiresExplicitMaintenanceConsent":true,"started":false})
    );
    Ok(())
}
fn revise_nomination(
    config: &Path,
    expected_request_digest: &str,
    default_high_mib: u32,
    employee_high: Vec<(ProfileEmployeeId, u32)>,
) -> Result<(), Box<dyn std::error::Error>> {
    let expected = JournalDigest::parse(expected_request_digest)?;
    let (snapshot, runtime) = capture(config)?;
    let published = reverie_application::installing_broker::revise_os_worker_pool_nomination(
        &snapshot,
        runtime,
        &expected,
        default_high_mib,
        employee_high,
        Instant::now() + Duration::from_secs(30),
    )?;
    let request: serde_json::Value = serde_json::from_slice(published.canonical_request())?;
    println!(
        "{}",
        serde_json::json!({"nominationRevised":true,"path":published.path(),
        "requestDigest":published.request_digest(),"proposedNomination":request,
        "defaultHighMiBMaterializedForCurrentRoster":default_high_mib,
        "requiresFreshOffer":true,"requiresExplicitMaintenanceConsent":true,"started":false})
    );
    Ok(())
}
fn employee_high(raw: &str) -> Result<(ProfileEmployeeId, u32), String> {
    let (id, high) = raw
        .split_once('=')
        .ok_or_else(|| "Use canonical-employee-UUID=MiB".to_owned())?;
    let id =
        ProfileEmployeeId::parse(id).map_err(|_| "Employee must be a canonical UUID".to_owned())?;
    let high = high
        .parse::<u32>()
        .map_err(|_| "Soft RAM must be integer MiB".to_owned())?;
    Ok((id, high))
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
