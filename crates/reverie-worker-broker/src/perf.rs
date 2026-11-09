//! Thin CLI over the shared native profiling policy application service.
use super::*;
use clap::{Args, ValueEnum};
use reverie_core::{
    ids::ProfileEmployeeId,
    operations::{JournalDigest, JournalId},
    task_perf::TaskPerfPolicy,
};
use reverie_host::worker_service::capture_stopped_worker_service;
use std::time::{Duration, Instant};

#[derive(Debug)]
struct FinalizedFailure {
    primary: Box<dyn std::error::Error>,
    cleanup: Option<Box<dyn std::error::Error>>,
}
impl std::fmt::Display for FinalizedFailure {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.primary.fmt(out)?;
        if let Some(cleanup) = &self.cleanup {
            write!(out, "; cleanup: {cleanup}")?;
        }
        Ok(())
    }
}
impl std::error::Error for FinalizedFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.primary.as_ref())
    }
}
fn finalized(
    primary: Box<dyn std::error::Error>,
    cleanup: Option<Box<dyn std::error::Error>>,
) -> Box<dyn std::error::Error> {
    Box::new(FinalizedFailure { primary, cleanup })
}

#[derive(Clone, Copy, ValueEnum)]
pub(super) enum Policy {
    TaskV2,
    Off,
}
impl Policy {
    fn selected(self) -> Option<TaskPerfPolicy> {
        match self {
            Self::TaskV2 => Some(TaskPerfPolicy::TaskV2),
            Self::Off => None,
        }
    }
    fn label(self) -> &'static str {
        match self {
            Self::TaskV2 => "task-v2",
            Self::Off => "off",
        }
    }
}
#[derive(Args)]
pub(super) struct Selection {
    /// Existing registered owner configuration beneath ~/reverie.
    #[arg(long, value_name = "FILE")]
    config: PathBuf,
    /// Exact employee UUID; session IDs and display names are not accepted.
    #[arg(long, value_name = "EMPLOYEE_UUID")]
    employee: String,
    /// Task-v2 permits own-task profiling; off removes this employee's entry.
    #[arg(long, value_enum)]
    policy: Policy,
}
#[derive(Subcommand)]
pub(super) enum Action {
    /// Inspect the exact proposed policy and obtain its preview digest.
    Preview {
        #[command(flatten)]
        selection: Selection,
    },
    /// Publish only the reviewed policy/domain transition. Requires the
    /// registered native service and all affected workers already stopped.
    Apply {
        #[command(flatten)]
        selection: Selection,
        #[arg(long, value_name = "SHA256")]
        expected_preview: String,
        /// Fresh nonnil operation UUID. Inspect a lost result before retrying.
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
    let employee = ProfileEmployeeId::parse(&selection.employee)?;
    let end = Instant::now() + Duration::from_secs(300);
    let broker = super::offline_owner::capture(&selection.config)?;
    let mut prepared =
        broker.prepare_offline_perf_switch(employee, selection.policy.selected(), end)?;
    let preview = prepared.preview_digest().as_str().to_owned();
    let configuration = prepared.configuration_digest().as_str().to_owned();
    if let Some((expected, operation)) = apply {
        if prepared.preview_digest() != &expected {
            return Err(finalized(
                "NATIVE_PERF_PREVIEW_CHANGED".into(),
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
        let closed = prepared.apply(service, &expected, operation)?;
        println!(
            "{}",
            serde_json::json!({"applied":true,"employeeId":selection.employee,
            "policy":selection.policy.label(),"previewDigest":closed.preview_digest().as_str(),
            "configurationDigest":closed.configuration_digest().as_str(),
            "started":false,"fleetRecreated":false})
        );
    } else {
        prepared.close(end)?;
        println!(
            "{}",
            serde_json::json!({"applied":false,"employeeId":selection.employee,
            "policy":selection.policy.label(),"previewDigest":preview,
            "configurationDigest":configuration,"started":false,"fleetRecreated":false})
        );
    }
    Ok(())
}
