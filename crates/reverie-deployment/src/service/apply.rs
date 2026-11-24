use super::*;
use reverie_host::deployment_snapshot::{RehearsalRoot, SnapshotTools};
use std::io::{Read, Write};
mod live_accounts;
mod restore;
mod retained_copy;

#[derive(Clone, Copy)]
enum BackupFormat {
    Tar,
    Gzip,
}

/// Ordinary legacy budgets remain unchanged. The whole initial owner passes
/// its SAME original bound, never a new grace period or a writer exception.
#[derive(Clone, Copy)]
pub(super) enum OperationDeadline {
    Ordinary,
    Initial(Instant),
}
impl OperationDeadline {
    fn timeout(self, cap: Duration) -> Option<Duration> {
        match self {
            Self::Ordinary => Some(cap),
            Self::Initial(end) => end
                .checked_duration_since(Instant::now())
                .filter(|left| !left.is_zero())
                .map(|left| left.min(cap)),
        }
    }
    pub(super) fn check(self) -> Result<()> {
        match self {
            Self::Ordinary => Ok(()),
            Self::Initial(end) => require(Instant::now() < end, "DEPLOYMENT_OPERATION_DEADLINE"),
        }
    }
    fn snapshot(self) -> Instant {
        let end = Instant::now() + Duration::from_secs(1800);
        match self {
            Self::Ordinary => end,
            Self::Initial(original) => end.min(original),
        }
    }
    fn readiness(self) -> Instant {
        let end = Instant::now() + Duration::from_secs(60);
        match self {
            Self::Ordinary => end,
            Self::Initial(original) => end.min(original),
        }
    }
    /// The owner's own update brings the original console back when it
    /// fails. The bounded initial rollout settles its own failure under its
    /// one deadline, which has no allowance for a second readiness wait.
    fn restores_source(self) -> bool {
        matches!(self, Self::Ordinary)
    }
}
impl DeploymentService {
    /// Recover a stopped source after backup verification refused.
    pub fn activate_retained(&self, id: &str) -> Result<DeploymentStatus> {
        self.activate_retained_scoped(id, false)
    }

    /// Stop a running source and retain an ordinary, unrehearsed copy.
    pub fn activate_retained_from_running(&self, id: &str) -> Result<DeploymentStatus> {
        self.activate_retained_scoped(id, true)
    }

    fn activate_retained_scoped(
        &self,
        id: &str,
        stop_running_source: bool,
    ) -> Result<DeploymentStatus> {
        let operation = self.effect_operation(id)?;
        self.claimed(&operation)?;
        operation.prepared()?;
        self.source_current(&operation, stop_running_source)?;
        require(
            !operation.exists("old-rename-attempt")
                && !operation.exists("start-attempt")
                && !operation.exists("rollback-attempt")
                && !operation.exists("retained-copy-attempt"),
            "DEPLOYMENT_SWAP_ALREADY_ATTEMPTED",
        )?;
        let stopped_before = operation.exists("stop-attempt");
        let pins = self.pins(&operation)?;
        let result = (|| {
            let candidate = operation.candidate()?;
            let actual = self.engine.container(&candidate)?;
            operation.plan.candidate_matches(&actual, &self.engine)?;
            require(
                actual["Name"] == format!("/{}", temporary_name(&operation, "candidate"))
                    && actual["State"]["Running"] == false
                    && actual["State"]["Status"] == "created",
                "DEPLOYMENT_CANDIDATE_NOT_SLEEPING",
            )?;
            let copy = retained_copy::program()?;
            let source = self.data_source(&operation)?.join("console");
            let destination = operation.directory.join("retained-copy");
            require(!destination.try_exists()?, "DEPLOYMENT_COPY_OCCUPIED")?;
            if stop_running_source {
                self.stop_for_retained_copy(&operation, &pins)?;
            }
            operation.attempt("retained-copy-attempt")?;
            retained_copy::run(
                copy,
                &source,
                &destination,
                OperationDeadline::Ordinary.snapshot(),
            )?;
            self.verify_effect_pins(&operation, &pins)?;
            self.source_current(&operation, false)?;
            operation.record(
                "unverified-backup-accepted",
                &json!({
                    "backupVerified":false,"copy":destination,"copyExitSuccess":true,
                    "policy":"explicit-owner-fix-forward","sourceDataDeleted":false
                }),
            )?;
            self.swap(&operation, &candidate, &pins)?;
            operation.status()
        })();
        let result = self.restoring_source(&operation, &pins, stopped_before, result);
        DeploymentError::finalized(result, pins.close())
    }

    fn stop_for_retained_copy(
        &self,
        operation: &Operation,
        pins: &crate::pins::Pins,
    ) -> Result<()> {
        require(
            !operation.exists("stop-attempt") && operation.plan.live_account_writers.is_none(),
            "DEPLOYMENT_RETAINED_STOP_NOT_ADMITTED",
        )?;
        let source = self.source_current(operation, true)?;
        require(
            source["Name"] == format!("/{}", operation.plan.container),
            "DEPLOYMENT_SOURCE_NAME_CHANGED",
        )?;
        pins.running_mounts(&source)?;
        self.refuse_shared_writers(&source)?;
        self.verify_effect_pins(operation, pins)?;
        operation.attempt("stop-attempt")?;
        self.engine.stop(model::string(&source, "Id")?)?;
        self.source_current(operation, false)?;
        self.verify_effect_pins(operation, pins)
    }
    /// Explicit owner-selected update without a backup. All ordinary source,
    /// pins, candidate, writer exclusion and one-attempt swap guards still hold.
    pub(crate) fn apply_without_backup_before(
        &self,
        id: &str,
        end: Instant,
    ) -> Result<DeploymentStatus> {
        let deadline = OperationDeadline::Initial(end);
        deadline.check()?;
        let operation = self.effect_operation(id)?;
        let pins = self.pins(&operation)?;
        let result = (|| {
            self.claimed(&operation)?;
            operation.prepared()?;
            require(
                !operation.exists("stop-attempt")
                    && !operation.exists("old-rename-attempt")
                    && !operation.exists("start-attempt"),
                "DEPLOYMENT_SWAP_ALREADY_ATTEMPTED",
            )?;
            let source = self.source_current(&operation, true)?;
            require(
                source["Name"] == format!("/{}", self.installation.name),
                "DEPLOYMENT_SOURCE_NAME_CHANGED",
            )?;
            let candidate = operation.candidate()?;
            let actual = self.engine.container(&candidate)?;
            operation.plan.candidate_matches(&actual, &self.engine)?;
            require(
                actual["Name"] == format!("/{}", temporary_name(&operation, "candidate"))
                    && actual["State"]["Running"] == false
                    && actual["State"]["Status"] == "created",
                "DEPLOYMENT_CANDIDATE_NOT_SLEEPING",
            )?;
            pins.running_mounts(&source)?;
            self.refuse_shared_writers(&source)?;
            deadline.check()?;
            operation.record("unverified-backup-accepted", &json!({"backupVerified":false,
                "backupCreated":false,"policy":"explicit-owner-skip-backup","sourceDataDeleted":false}))?;
            operation.attempt("stop-attempt")?;
            self.engine.stop(model::string(&source, "Id")?)?;
            self.source_current(&operation, false)?;
            self.verify_effect_pins(&operation, &pins)?;
            self.swap_scoped(&operation, &candidate, &pins, deadline)?;
            operation.status()
        })();
        DeploymentError::finalized(result, pins.close())
    }
    /// Execute the exact prepared release. The stopped-data copy and rehearsal
    /// must finish before the old container is renamed. No bulk employee wake.
    pub fn apply(&self, id: &str) -> Result<DeploymentStatus> {
        self.apply_scoped(id, OperationDeadline::Ordinary, false, None)
    }
    /// Keep the archive in the operation and extract its rehearsal on the selected disk.
    pub fn apply_with_rehearsal_root(&self, id: &str, root: &Path) -> Result<DeploymentStatus> {
        self.apply_scoped(
            id,
            OperationDeadline::Ordinary,
            false,
            Some((root, BackupFormat::Tar)),
        )
    }

    /// Stage the raw copy and extraction on the second disk, then verify a compressed durable archive.
    pub fn apply_with_compressed_backup(&self, id: &str, root: &Path) -> Result<DeploymentStatus> {
        self.apply_scoped(
            id,
            OperationDeadline::Ordinary,
            false,
            Some((root, BackupFormat::Gzip)),
        )
    }

    /// Apply the prepared live-writer plan under its existing exact mount and
    /// process pins, with explicit owner authorization to omit the data copy.
    pub fn apply_live_without_backup(&self, id: &str) -> Result<DeploymentStatus> {
        self.apply_scoped(id, OperationDeadline::Ordinary, true, None)
    }
    pub(crate) fn apply_before(&self, id: &str, end: Instant) -> Result<DeploymentStatus> {
        self.apply_scoped(id, OperationDeadline::Initial(end), false, None)
    }
    fn apply_scoped(
        &self,
        id: &str,
        deadline: OperationDeadline,
        skip_live_backup: bool,
        rehearsal_path: Option<(&Path, BackupFormat)>,
    ) -> Result<DeploymentStatus> {
        deadline.check()?;
        let operation = self.effect_operation(id)?;
        let rehearsal = rehearsal_path
            .map(|(path, format)| {
                require(
                    operation.plan.live_account_writers.is_none(),
                    "DEPLOYMENT_VERIFIED_BACKUP_REQUIRED",
                )?;
                RehearsalRoot::open(
                    path,
                    &self.data_source(&operation)?,
                    &operation.directory,
                    deadline.snapshot(),
                )
                .map(|root| (root, format))
                .map_err(|error| {
                    DeploymentError::snapshot("DEPLOYMENT_REHEARSAL_ROOT_REFUSED", error)
                })
            })
            .transpose()?;
        let stopped_before = operation.exists("stop-attempt");
        let result = (|| {
            let pins = self.pins(&operation)?;
            let applied = self.apply_pinned(
                &operation,
                &pins,
                deadline,
                skip_live_backup,
                rehearsal.as_ref().map(|(root, format)| (root, *format)),
            );
            let applied = if deadline.restores_source() {
                self.restoring_source(&operation, &pins, stopped_before, applied)
            } else {
                applied
            };
            DeploymentError::finalized(applied, pins.close())
        })();
        let closed = rehearsal.map_or(Ok(()), |(root, _)| {
            root.close().map_err(|error| {
                DeploymentError::snapshot("DEPLOYMENT_REHEARSAL_CLOSE_UNCONFIRMED", error)
            })
        });
        DeploymentError::finalized(result, closed).map_err(|error| {
            if !error.has_snapshot() {
                return error;
            }
            match self.installation.current() {
                Ok(()) => operation.record_snapshot_refusal(error),
                Err(close) => error.with_finalizer(close),
            }
        })
    }
    fn apply_pinned(
        &self,
        operation: &Operation,
        pins: &crate::pins::Pins,
        deadline: OperationDeadline,
        skip_live_backup: bool,
        rehearsal: Option<(&RehearsalRoot, BackupFormat)>,
    ) -> Result<DeploymentStatus> {
        self.claimed(operation)?;
        operation.prepared()?;
        let source = self.source_current(operation, true)?;
        require(
            source["Name"] == format!("/{}", self.installation.name),
            "DEPLOYMENT_SOURCE_NAME_CHANGED",
        )?;
        let candidate = operation.candidate()?;
        let current = self.engine.container(&candidate)?;
        operation.plan.candidate_matches(&current, &self.engine)?;
        require(
            current["State"]["Running"] == false && current["State"]["Status"] == "created",
            "DEPLOYMENT_CANDIDATE_ALREADY_STARTED",
        )?;
        require(
            current["Name"] == format!("/{}", temporary_name(operation, "candidate")),
            "DEPLOYMENT_CANDIDATE_NAME_CHANGED",
        )?;
        if operation.plan.live_account_writers.is_some() {
            return self.apply_live_accounts(
                operation,
                &source,
                &candidate,
                pins,
                deadline,
                skip_live_backup,
            );
        }
        require(!skip_live_backup, "DEPLOYMENT_LIVE_ACCOUNT_PLAN_REQUIRED")?;
        let source_root = self.data_source(operation)?;
        let tools = snapshot_tools()?;
        pins.running_mounts(&source)?;
        self.refuse_shared_writers(&source)?;
        deadline.check()?;
        operation.attempt("stop-attempt")?;
        deadline.check()?;
        self.engine.stop(model::string(&source, "Id")?)?;
        self.source_current(operation, false)?;
        self.verify_effect_pins(operation, pins)?;
        let end = deadline.snapshot();
        let destination = operation.directory.join("snapshot");
        let staged = match rehearsal {
            Some((root, BackupFormat::Gzip)) => root.stage(&tools, &source_root, end),
            _ => tools.stage_console(&source_root, &destination, end),
        }
        .map_err(|error| DeploymentError::snapshot("DEPLOYMENT_SNAPSHOT_REFUSED", error))?;
        if let Err(error) = self.source_current(operation, false) {
            return DeploymentError::finalized(
                Err(error),
                staged.close().map_err(|error| {
                    DeploymentError::snapshot("DEPLOYMENT_SNAPSHOT_CLOSE_UNCONFIRMED", error)
                }),
            );
        }
        let mut snapshot = staged
            .rehearse(
                rehearsal
                    .and_then(|(root, format)| matches!(format, BackupFormat::Tar).then_some(root)),
                deadline.snapshot(),
            )
            .map_err(|error| {
                DeploymentError::snapshot("DEPLOYMENT_RESTORE_REHEARSAL_REFUSED", error)
            })?;
        let verified = self.record_release_snapshot(operation, &mut snapshot, rehearsal, deadline);
        let closed = snapshot.close().map_err(|error| {
            DeploymentError::snapshot("DEPLOYMENT_SNAPSHOT_CLOSE_UNCONFIRMED", error)
        });
        DeploymentError::finalized(verified, closed)?;
        self.source_current(operation, false)?;
        self.swap_scoped(operation, &candidate, pins, deadline)?;
        operation.status()
    }
    fn record_release_snapshot(
        &self,
        operation: &Operation,
        snapshot: &mut reverie_host::deployment_snapshot::ConsoleSnapshot,
        rehearsal: Option<(&RehearsalRoot, BackupFormat)>,
        deadline: OperationDeadline,
    ) -> Result<()> {
        self.source_current(operation, false)?;
        let (archive, checksum) = if matches!(rehearsal, Some((_, BackupFormat::Gzip))) {
            snapshot
                .compressed_copy(&operation.directory.join("snapshot"), deadline.snapshot())
                .map_err(|error| {
                    DeploymentError::snapshot("DEPLOYMENT_COMPRESSED_BACKUP_REFUSED", error)
                })?
        } else {
            (
                snapshot.archive_path(),
                snapshot.archive_sha256().to_owned(),
            )
        };
        self.source_current(operation, false)?;
        operation.record("snapshot", &json!({"archive":archive,"sha256":checksum,"tarSha256":snapshot.archive_sha256(),
            "entries":snapshot.entry_count(),"regularBytes":snapshot.regular_bytes(),"scope":snapshot.scope_note(),"manifestSHA256":snapshot.manifest_sha256()}))?;
        Ok(())
    }
    fn swap(&self, operation: &Operation, candidate: &str, pins: &crate::pins::Pins) -> Result<()> {
        self.swap_scoped(operation, candidate, pins, OperationDeadline::Ordinary)
    }
    fn swap_scoped(
        &self,
        operation: &Operation,
        candidate: &str,
        pins: &crate::pins::Pins,
        deadline: OperationDeadline,
    ) -> Result<()> {
        deadline.check()?;
        let old = model::string(&operation.plan.source, "Id")?;
        self.source_current(operation, false)?;
        self.verify_effect_pins(operation, pins)?;
        operation.attempt("old-rename-attempt")?;
        deadline.check()?;
        self.engine
            .rename(old, &temporary_name(operation, "before-front"))?;
        operation.record("old-renamed", &json!({"id":old}))?;
        operation.attempt("new-rename-attempt")?;
        deadline.check()?;
        self.engine.rename(candidate, &operation.plan.container)?;
        operation.record("new-renamed", &json!({"id":candidate}))?;
        operation.attempt("start-attempt")?;
        self.verify_effect_pins(operation, pins)?;
        operation
            .plan
            .candidate_matches(&self.engine.container(candidate)?, &self.engine)?;
        deadline.check()?;
        self.engine.start(candidate)?;
        operation.record("started", &json!({"id":candidate}))?;
        self.await_ready_scoped(candidate, true, deadline)?;
        self.publish_ready(operation, candidate, pins, deadline)
    }
    fn publish_ready(
        &self,
        operation: &Operation,
        candidate: &str,
        pins: &crate::pins::Pins,
        deadline: OperationDeadline,
    ) -> Result<()> {
        self.source_current(operation, false)?;
        let old = model::string(&operation.plan.source, "Id")?;
        require(
            operation.candidate()? == candidate,
            "DEPLOYMENT_CANDIDATE_CHANGED",
        )?;
        let running = self.engine.container(candidate)?;
        require(
            running["Id"] == candidate && running["State"]["Running"] == true,
            "DEPLOYMENT_CANDIDATE_CHANGED",
        )?;
        operation.plan.candidate_matches(&running, &self.engine)?;
        model::port_binding(&running, self.installation.port)?;
        require(
            running["Name"] == format!("/{}", operation.plan.container),
            "DEPLOYMENT_CANDIDATE_NAME_CHANGED",
        )?;
        pins.running_mounts(&running)?;
        self.verify_effect_pins(operation, pins)?;
        deadline.check()?;
        operation.record(
            "ready",
            &json!({"containerId":candidate,"mode":"hybrid-rust-front", "brokerChanged":false,
            "employeeReadiness":"PENDING_ONE_SEAT_TRIAL","rollbackContainerId":old,
            "backupVerified":!operation.exists("unverified-backup-accepted")}),
        )
    }
    pub(crate) fn await_ready(&self, id: &str, front: bool) -> Result<()> {
        self.await_ready_scoped(id, front, OperationDeadline::Ordinary)
    }
    fn await_ready_scoped(&self, id: &str, front: bool, deadline: OperationDeadline) -> Result<()> {
        let end = deadline.readiness();
        while Instant::now() < end {
            let current = self.engine.container(id)?;
            require(
                current["State"]["Running"] == true,
                "DEPLOYMENT_WEBSITE_EXITED",
            )?;
            if status_responds_scoped(self.installation.port, deadline)
                && self.process_tree(id, front).is_ok()
            {
                deadline.check()?;
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        Err(DeploymentError::new("DEPLOYMENT_READINESS_UNCONFIRMED"))
    }
    pub(super) fn process_tree(&self, id: &str, required: bool) -> Result<()> {
        let value = self.engine.json(
            "GET",
            &format!("/containers/{id}/top?ps_args=-eo%20pid,ppid,comm"),
            None,
        )?;
        let rows = value["Processes"]
            .as_array()
            .ok_or_else(|| DeploymentError::new("DEPLOYMENT_PROCESS_UNKNOWN"))?;
        let front = rows
            .iter()
            .filter(|r| r[2] == "reverie-front")
            .collect::<Vec<_>>();
        if !required {
            return require(front.is_empty(), "DEPLOYMENT_RESTORE_STILL_FRONT");
        }
        require(
            front.len() == 1 && rows.iter().any(|r| r[2] == "node" && r[1] == front[0][0]),
            "DEPLOYMENT_FRONT_PROCESS_UNCONFIRMED",
        )
    }
}
fn snapshot_tools() -> Result<SnapshotTools> {
    let tar = option_env!("REVERIE_DEPLOYMENT_TAR")
        .ok_or_else(|| DeploymentError::new("DEPLOYMENT_SNAPSHOT_TOOLS_UNINSTALLED"))?;
    let attr = option_env!("REVERIE_DEPLOYMENT_GETFATTR")
        .ok_or_else(|| DeploymentError::new("DEPLOYMENT_SNAPSHOT_TOOLS_UNINSTALLED"))?;
    let acl = option_env!("REVERIE_DEPLOYMENT_GETFACL")
        .ok_or_else(|| DeploymentError::new("DEPLOYMENT_SNAPSHOT_TOOLS_UNINSTALLED"))?;
    SnapshotTools::capture_installed(Path::new(tar), Path::new(attr), Path::new(acl))
        .map_err(|error| DeploymentError::snapshot("DEPLOYMENT_SNAPSHOT_TOOLS_INVALID", error))
}
pub(super) fn status_responds_scoped(port: u16, deadline: OperationDeadline) -> bool {
    let Some(timeout) = deadline.timeout(Duration::from_secs(2)) else {
        return false;
    };
    let Ok(mut stream) =
        std::net::TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), timeout)
    else {
        return false;
    };
    if stream.set_read_timeout(Some(timeout)).is_err()
        || stream.set_write_timeout(Some(timeout)).is_err()
    {
        return false;
    }
    let request =
        format!("GET /api/status HTTP/1.1\r\nHost:127.0.0.1:{port}\r\nConnection:close\r\n\r\n");
    let Some(timeout) = deadline.timeout(Duration::from_secs(2)) else {
        return false;
    };
    if stream.set_write_timeout(Some(timeout)).is_err()
        || stream.write_all(request.as_bytes()).is_err()
    {
        return false;
    }
    let mut line = Vec::new();
    while line.len() < 256 {
        if let OperationDeadline::Initial(_) = deadline {
            let Some(timeout) = deadline.timeout(Duration::from_secs(2)) else {
                return false;
            };
            if stream.set_read_timeout(Some(timeout)).is_err() {
                return false;
            }
        }
        let mut byte = [0];
        if stream.read_exact(&mut byte).is_err() {
            return false;
        }
        line.push(byte[0]);
        if byte[0] == b'\n' {
            break;
        }
    }
    line.starts_with(b"HTTP/1.1 401 ") || line.starts_with(b"HTTP/1.0 401 ")
}
