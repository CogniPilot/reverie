//! Refuse while the office still runs what would otherwise fail after it has
//! been stopped: the rehearsal directory, the backup destination and the
//! free space for both copies. Nothing here creates, stops or changes anything.
use super::*;
use reverie_host::deployment_snapshot::{ConsoleEstimate, admit_console, estimate_console};
use std::os::unix::fs::MetadataExt;
#[cfg(test)]
mod tests;

const INSUFFICIENT: &str = "DEPLOYMENT_BACKUP_SPACE_INSUFFICIENT";
/// The console keeps writing until it is stopped, and the estimate was taken
/// before that. Each filesystem needs one sixteenth more plus this much.
const MARGIN_BYTES: u64 = 256 << 20;

/// Free space of one filesystem, identified by its device.
#[derive(Clone, Copy)]
struct Volume {
    device: u64,
    available: u64,
}
impl Volume {
    fn observe(path: &Path) -> Result<Self> {
        let space = nix::sys::statvfs::statvfs(path)
            .map_err(|_| DeploymentError::new("DEPLOYMENT_BACKUP_SPACE_UNOBSERVED"))?;
        Ok(Self {
            device: std::fs::metadata(path)?.dev(),
            available: space
                .blocks_available()
                .saturating_mul(space.fragment_size()),
        })
    }
}
fn required(bytes: u64) -> u64 {
    bytes
        .saturating_add(bytes / 16)
        .saturating_add(MARGIN_BYTES)
}
/// Which copy lands on which filesystem. The compressed archive is left out:
/// its size is known only once the verified archive has been compressed.
fn storage_report(
    estimate: &ConsoleEstimate,
    operation: Volume,
    rehearsal: Option<(Volume, BackupFormat)>,
) -> Value {
    let (archive, extracted) = (estimate.archive_bytes(), estimate.rehearsal_bytes());
    let copies = match rehearsal {
        None => [
            (operation, "archive", archive),
            (operation, "rehearsal", extracted),
        ],
        Some((selected, BackupFormat::Tar)) => [
            (operation, "archive", archive),
            (selected, "rehearsal", extracted),
        ],
        Some((selected, BackupFormat::Gzip)) => [
            (selected, "archive", archive),
            (selected, "rehearsal", extracted),
        ],
    };
    let mut filesystems: Vec<(Volume, Vec<&str>, u64)> = Vec::new();
    for (volume, copy, bytes) in copies {
        match filesystems
            .iter_mut()
            .find(|(known, _, _)| known.device == volume.device)
        {
            Some((_, holds, total)) => {
                holds.push(copy);
                *total = total.saturating_add(bytes);
            }
            None => filesystems.push((volume, vec![copy], bytes)),
        }
    }
    let rows = filesystems
        .iter()
        .map(|(volume, holds, bytes)| {
            json!({"holds":holds,"requiredBytes":required(*bytes),
                "availableBytes":volume.available,
                "sufficient":volume.available >= required(*bytes)})
        })
        .collect::<Vec<_>>();
    json!({
        "consoleEntries":estimate.entries(),
        "consoleRegularBytes":estimate.regular_bytes(),
        "archiveBytes":archive,
        "rehearsalBytes":extracted,
        "sufficient":rows.iter().all(|row| row["sufficient"] == true),
        "filesystems":rows,
    })
}
pub(super) fn open_rehearsal(
    path: &Path,
    source_root: &Path,
    operation: &Path,
    end: Instant,
) -> Result<RehearsalRoot> {
    RehearsalRoot::open(path, source_root, operation, end)
        .map_err(|error| DeploymentError::snapshot("DEPLOYMENT_REHEARSAL_ROOT_REFUSED", error))
}
/// `operation` is the directory that will hold the durable archive.
pub(super) fn backup_admitted(
    operation: &Path,
    source_root: &Path,
    rehearsal: Option<(&RehearsalRoot, BackupFormat)>,
    end: Instant,
) -> Result<Value> {
    let durable = operation.join("snapshot");
    let staging = match rehearsal {
        Some((root, BackupFormat::Gzip)) => root.path().join("snapshot"),
        _ => durable.clone(),
    };
    admit_console(source_root, &staging, end)
        .map_err(|error| DeploymentError::snapshot("DEPLOYMENT_SNAPSHOT_REFUSED", error))?;
    require(
        staging == durable || !durable.try_exists()?,
        "DEPLOYMENT_SNAPSHOT_OCCUPIED",
    )?;
    let estimate = estimate_console(source_root, end)
        .map_err(|error| DeploymentError::snapshot("DEPLOYMENT_BACKUP_ESTIMATE_REFUSED", error))?;
    let selected = rehearsal
        .map(|(root, format)| Ok::<_, DeploymentError>((Volume::observe(root.path())?, format)))
        .transpose()?;
    let report = storage_report(&estimate, Volume::observe(operation)?, selected);
    if report["sufficient"] == true {
        Ok(report)
    } else {
        Err(DeploymentError::new(INSUFFICIENT).with_detail(report))
    }
}
impl DeploymentService {
    /// Report, at any time and without any effect, whether a verified
    /// update's backup would be admitted: the optional rehearsal directory,
    /// the backup destination and the free space for the archive and the
    /// restore rehearsal. Apply repeats the same checks before its stop.
    pub fn check_backup_storage(
        &self,
        rehearsal_root: Option<&Path>,
        compress: bool,
    ) -> Result<Value> {
        let source_root = data_source_value(&self.running_source()?)?;
        let deployments = self.installation.state.join("console-deployments");
        let operations = if deployments.is_dir() {
            deployments
        } else {
            self.installation.state.clone()
        };
        let end = OperationDeadline::Ordinary.snapshot();
        let format = if compress {
            BackupFormat::Gzip
        } else {
            BackupFormat::Tar
        };
        let root = rehearsal_root
            .map(|path| open_rehearsal(path, &source_root, &operations, end))
            .transpose()?;
        let report = backup_admitted(
            &operations,
            &source_root,
            root.as_ref().map(|root| (root, format)),
            end,
        );
        let closed = root.map_or(Ok(()), |root| {
            root.close().map_err(|error| {
                DeploymentError::snapshot("DEPLOYMENT_REHEARSAL_CLOSE_UNCONFIRMED", error)
            })
        });
        DeploymentError::finalized(report, closed)
    }
    /// What the stop will cost, measured while the office runs. A refused
    /// measurement is reported, not hidden; apply decides again before its stop.
    pub(in crate::service) fn stopped_backup(&self, source: &Value) -> model::StoppedBackupPreview {
        let measured = data_source_value(source).and_then(|root| {
            estimate_console(&root, Instant::now() + Duration::from_secs(60)).map_err(|error| {
                DeploymentError::snapshot("DEPLOYMENT_BACKUP_ESTIMATE_REFUSED", error)
            })
        });
        let (estimate, estimate_refusal) = match measured {
            Ok(estimate) => (
                Some(model::StoppedBackupEstimate {
                    console_entries: estimate.entries(),
                    console_regular_bytes: estimate.regular_bytes(),
                    archive_bytes: estimate.archive_bytes(),
                    rehearsal_bytes: estimate.rehearsal_bytes(),
                    bytes_written_while_stopped: estimate.stopped_write_bytes(),
                    bytes_read_while_stopped: estimate.stopped_read_bytes(),
                }),
                None,
            ),
            Err(error) => (
                None,
                Some(
                    error
                        .snapshot_error()
                        .map_or(error.code(), |cause| cause.code())
                        .to_owned(),
                ),
            ),
        };
        model::StoppedBackupPreview {
            estimate,
            estimate_refusal,
            note: "The office is stopped while its console data is archived, verified and extracted for the restore rehearsal. These figures were measured while it was running.".into(),
        }
    }
}
