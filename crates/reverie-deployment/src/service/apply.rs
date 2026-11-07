use super::*;
use reverie_host::deployment_snapshot::SnapshotTools;
use std::io::{Read, Write};
impl DeploymentService {
    /// Explicit owner recovery after backup verification refused. Preserve a
    /// full ordinary copy, with no claim that independently live writers paused.
    pub fn activate_retained(&self, id: &str) -> Result<DeploymentStatus> {
        let operation = self.operation(id)?;
        self.claimed(&operation)?;
        operation.prepared()?;
        self.source_current(&operation, false)?;
        require(
            !operation.exists("old-rename-attempt") && !operation.exists("start-attempt"),
            "DEPLOYMENT_SWAP_ALREADY_ATTEMPTED",
        )?;
        let pins = self.pins(&operation)?;
        let result = (|| {
            let candidate = operation.candidate()?;
            let actual = self.engine.container(&candidate)?;
            model::candidate_matches(&actual, &operation.plan.source, &operation.plan.body)?;
            require(
                actual["Name"] == format!("/{}", temporary_name(&operation, "candidate"))
                    && actual["State"]["Running"] == false
                    && actual["State"]["Status"] == "created",
                "DEPLOYMENT_CANDIDATE_NOT_SLEEPING",
            )?;
            let copy = option_env!("REVERIE_DEPLOYMENT_COPY")
                .ok_or_else(|| DeploymentError::new("DEPLOYMENT_COPY_UNINSTALLED"))?;
            let source = self.data_source(&operation)?.join("console");
            let destination = operation.directory.join("retained-copy");
            require(!destination.try_exists()?, "DEPLOYMENT_COPY_OCCUPIED")?;
            operation.attempt("retained-copy-attempt")?;
            let status = std::process::Command::new(copy)
                .args(["--archive", "--reflink=auto", "--no-target-directory", "--"])
                .arg(source)
                .arg(&destination)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()?;
            require(status.success(), "DEPLOYMENT_RETAINED_COPY_UNCONFIRMED")?;
            pins.verify()?;
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
        DeploymentError::finalized(result, pins.close())
    }
    /// Execute the exact prepared release. The stopped-data copy and rehearsal
    /// must finish before the old container is renamed. No bulk employee wake.
    pub fn apply(&self, id: &str) -> Result<DeploymentStatus> {
        let operation = self.operation(id)?;
        let pins = self.pins(&operation)?;
        let result = self.apply_pinned(&operation, &pins);
        DeploymentError::finalized(result, pins.close())
    }
    fn apply_pinned(
        &self,
        operation: &Operation,
        pins: &crate::pins::Pins,
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
        model::candidate_matches(&current, &operation.plan.source, &operation.plan.body)?;
        require(
            current["State"]["Running"] == false && current["State"]["Status"] == "created",
            "DEPLOYMENT_CANDIDATE_ALREADY_STARTED",
        )?;
        require(
            current["Name"] == format!("/{}", temporary_name(operation, "candidate")),
            "DEPLOYMENT_CANDIDATE_NAME_CHANGED",
        )?;
        let source_root = self.data_source(operation)?;
        let tools = snapshot_tools()?;
        pins.running_mounts(&source)?;
        operation.attempt("stop-attempt")?;
        self.engine.stop(model::string(&source, "Id")?)?;
        self.source_current(operation, false)?;
        pins.verify()?;
        let end = Instant::now() + Duration::from_secs(1800);
        let mut snapshot = tools
            .capture_console(&source_root, &operation.directory.join("snapshot"), end)
            .map_err(|_| DeploymentError::new("DEPLOYMENT_SNAPSHOT_REFUSED"))?;
        let verified = (|| {
            self.source_current(operation, false)?;
            snapshot
                .verify_source(end)
                .map_err(|_| DeploymentError::new("DEPLOYMENT_SNAPSHOT_CHANGED"))?;
            self.source_current(operation, false)?;
            snapshot
                .rehearse(end)
                .map_err(|_| DeploymentError::new("DEPLOYMENT_RESTORE_REHEARSAL_REFUSED"))?;
            self.source_current(operation, false)?;
            operation.record("snapshot", &json!({"archive":snapshot.archive_path(),"sha256":snapshot.archive_sha256(),
            "entries":snapshot.entry_count(),"regularBytes":snapshot.regular_bytes(),"scope":snapshot.scope_note(),"manifestSHA256":snapshot.manifest_sha256()}))?;
            Ok(())
        })();
        let closed = snapshot
            .close()
            .map_err(|_| DeploymentError::new("DEPLOYMENT_SNAPSHOT_CLOSE_UNCONFIRMED"));
        DeploymentError::finalized(verified, closed)?;
        self.source_current(operation, false)?;
        self.swap(operation, &candidate, pins)?;
        operation.status()
    }
    fn swap(&self, operation: &Operation, candidate: &str, pins: &crate::pins::Pins) -> Result<()> {
        let old = model::string(&operation.plan.source, "Id")?;
        self.source_current(operation, false)?;
        pins.verify()?;
        operation.attempt("old-rename-attempt")?;
        self.engine
            .rename(old, &temporary_name(operation, "before-front"))?;
        operation.record("old-renamed", &json!({"id":old}))?;
        operation.attempt("new-rename-attempt")?;
        self.engine.rename(candidate, &operation.plan.container)?;
        operation.record("new-renamed", &json!({"id":candidate}))?;
        operation.attempt("start-attempt")?;
        pins.verify()?;
        model::candidate_matches(
            &self.engine.container(candidate)?,
            &operation.plan.source,
            &operation.plan.body,
        )?;
        self.engine.start(candidate)?;
        operation.record("started", &json!({"id":candidate}))?;
        self.await_ready(candidate, true)?;
        self.source_current(operation, false)?;
        let running = self.engine.container(candidate)?;
        model::candidate_matches(&running, &operation.plan.source, &operation.plan.body)?;
        model::port_binding(&running, self.installation.port)?;
        require(
            running["Name"] == format!("/{}", operation.plan.container),
            "DEPLOYMENT_CANDIDATE_NAME_CHANGED",
        )?;
        pins.running_mounts(&running)?;
        operation.record(
            "ready",
            &json!({"containerId":candidate,"mode":"hybrid-rust-front", "brokerChanged":false,
            "employeeReadiness":"PENDING_ONE_SEAT_TRIAL","rollbackContainerId":old,
            "backupVerified":!operation.exists("unverified-backup-accepted")}),
        )
    }
    pub(crate) fn await_ready(&self, id: &str, front: bool) -> Result<()> {
        let end = Instant::now() + Duration::from_secs(60);
        while Instant::now() < end {
            let current = self.engine.container(id)?;
            require(
                current["State"]["Running"] == true,
                "DEPLOYMENT_WEBSITE_EXITED",
            )?;
            if status_responds(self.installation.port) && self.process_tree(id, front).is_ok() {
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
        .map_err(|_| DeploymentError::new("DEPLOYMENT_SNAPSHOT_TOOLS_INVALID"))
}
pub(super) fn status_responds(port: u16) -> bool {
    let timeout = Duration::from_secs(2);
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
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut line = Vec::new();
    while line.len() < 256 {
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
