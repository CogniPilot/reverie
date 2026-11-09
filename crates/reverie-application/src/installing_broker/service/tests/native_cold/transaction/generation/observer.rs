//! Exact original native process snapshots survive both broker process owners.
use super::*;
use reverie_host::website_facts::ProcessSnapshot;

#[derive(PartialEq)]
pub(super) struct Birth {
    cid: String,
    sid: String,
    started_at: String,
    runtime_publication: Vec<u8>,
    processes: [ProcessSnapshot; 3],
}
pub(super) struct Observer {
    runtime: Option<WorkerRuntime>,
    reader: Option<reconnect::ProviderReader>,
    cli: Option<Cli>,
    root: PathBuf,
    image: String,
    deployment: String,
    config: reverie_contracts::worker_config::EffectiveWorkerConfig,
    end: Instant,
    closed: bool,
}
impl Observer {
    pub(super) fn new(inputs: &Inputs, tenant: &Tenant, end: Instant) -> Result<Self> {
        let snapshot = crate::worker_validation::load_owner_config(&tenant.source)
            .map_err(|e| e.to_string())?;
        let mut env: BTreeMap<_, _> = std::env::vars_os().collect();
        for name in ["DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"] {
            env.remove(std::ffi::OsStr::new(name));
        }
        env.insert("DOCKER_HOST".into(), "unix:///var/run/docker.sock".into());
        env.insert(
            "DOCKER_CONFIG".into(),
            tenant.root.join("docker-config").into_os_string(),
        );
        let engine =
            EngineBootstrap::from_service(inputs.docker.as_os_str(), env, tenant.root.clone())
                .map_err(|e| e.to_string())?;
        let runtime = WorkerRuntime::new(
            InstalledWorkerEngine::new(engine),
            snapshot.envelope().base(),
        );
        let reader = reconnect::ProviderReader::new(runtime.readonly());
        let records = tenant.root.join("generation-observer");
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&records)
            .map_err(|e| e.to_string())?;
        Ok(Self {
            runtime: Some(runtime),
            reader: Some(reader),
            cli: Some(Cli::new(inputs.docker.clone(), records, end)),
            root: tenant.root.clone(),
            image: inputs.image.as_str().into(),
            deployment: tenant.deployment.clone(),
            config: snapshot.configuration().clone(),
            end,
            closed: false,
        })
    }
    pub(super) fn capture(&mut self, receipt: &serde_json::Value, sid: &str) -> Result<Birth> {
        let cid = receipt["containerId"]
            .as_str()
            .ok_or("actual created CID receipt")?;
        let id = reverie_core::ids::ContainerId::parse(cid).map_err(|e| e.to_string())?;
        let raw = self.cli.as_mut().expect("same observer CLI").success(&[
            "inspect",
            "--format",
            "{{json .}}",
            cid,
        ])?;
        let row: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        outside_production_pool(&row)?;
        require(
            row["Id"] == cid
                && row["Image"] == self.image
                && row["Name"] == format!("/{}-agent-{sid}", self.deployment)
                && row["Config"]["Labels"]["reverie.worker"] == self.deployment
                && row["Config"]["Labels"]["reverie.session"] == sid
                && row["State"]["Running"] == true
                && row["State"]["Paused"] == false
                && row["State"]["Dead"] == false
                && row["State"]["Restarting"] == false,
            "exact original live provider identity/flags",
        )?;
        let runtime = self.runtime.as_ref().expect("original observer runtime");
        let processes = self
            .reader
            .as_mut()
            .expect("original process reader")
            .observe(&id, self.end, &runtime.cancellation())?;
        let session = ProfileSessionId::parse(sid).map_err(|e| e.to_string())?;
        let selected = runtime
            .resolve_storage(&self.config, &session)
            .map_err(|e| e.to_string())?;
        require(
            selected
                .paths()
                .home()
                .starts_with(self.root.join("state/employees")),
            "same private employee home",
        )?;
        let publication = fs::read(self.root.join("state").join(sid).join("runtime.json"))
            .map_err(|e| e.to_string())?;
        let data =
            reverie_contracts::broker_laptop::LaunchRuntimeData::decode_read_text(&publication)
                .map_err(|e| e.to_string())?;
        let exit = data
            .exit()
            .codepoints()
            .iter()
            .map(|c| char::from_u32(*c))
            .collect::<Option<String>>()
            .ok_or("actual exit scalar")?;
        require(
            !exit.contains('/')
                && !exit.is_empty()
                && missing(&selected.paths().home().join(".reverie-launch").join(&exit))?
                && missing(&self.root.join("work/release"))?,
            "actual original command incomplete and unreleased",
        )?;
        verify_command(&processes.1, &processes.2, &exit)?;
        require(
            row["State"]["Pid"].as_u64() == processes.0.pid().to_u64(),
            "typed init and fresh Engine row agree",
        )?;
        Ok(Birth {
            cid: cid.into(),
            sid: sid.into(),
            started_at: row["State"]["StartedAt"]
                .as_str()
                .ok_or("actual StartedAt")?
                .into(),
            runtime_publication: publication,
            processes: [processes.0, processes.1, processes.2],
        })
    }
    pub(super) fn same(&mut self, original: &Birth, phase: &str) -> Result<()> {
        let current = self.capture(
            &serde_json::json!({"containerId":original.cid}),
            &original.sid,
        )?;
        require(
            current == *original,
            "broker generation replacement must preserve original sibling CID/init/controller/command/publication",
        )?;
        tenant::write(&self.root.join(format!("generation-{phase}.json")), &serde_json::to_vec(&serde_json::json!({"phase":phase,"containerId":current.cid,"sessionId":current.sid,"startedAt":current.started_at,"runtimePublicationBytes":current.runtime_publication,"init":reconnect::process_data(&current.processes[0]),"controller":reconnect::process_data(&current.processes[1]),"command":reconnect::process_data(&current.processes[2])})).map_err(|e| e.to_string())?)
    }
    pub(super) fn close(&mut self) -> Result<()> {
        self.reader.as_mut().expect("same reader").close(self.end)?;
        self.runtime
            .as_ref()
            .expect("same runtime")
            .close(self.end)
            .map_err(|e| e.to_string())?;
        require(
            self.cli.as_ref().expect("same CLI").known(),
            "observer native calls known closed",
        )?;
        self.closed = true;
        Ok(())
    }
    pub(super) fn require_removed(&mut self, receipts: &[&serde_json::Value]) -> Result<()> {
        for receipt in receipts {
            let id = receipt["containerId"]
                .as_str()
                .ok_or("actual original removed CID")?;
            reverie_core::ids::ContainerId::parse(id).map_err(|e| e.to_string())?;
            require(
                self.cli
                    .as_mut()
                    .expect("same observer CLI")
                    .success(&["ps", "-aq", "--no-trunc", "--filter", &format!("id={id}")])?
                    .trim()
                    .is_empty(),
                "independent fresh exact CID absence after actual known service close and nonforce removal",
            )?;
        }
        Ok(())
    }
}
fn verify_command(pane: &ProcessSnapshot, command: &ProcessSnapshot, exit: &str) -> Result<()> {
    use reverie_core::worker_child::{CHILD_PROGRAM, LAUNCH_DIRECTORY};
    let nonce = exit.strip_suffix(".exit").ok_or("actual pane-exit leaf")?;
    let paired = format!("{LAUNCH_DIRECTORY}/{exit}");
    let record = format!("{LAUNCH_DIRECTORY}/{nonce}.json");
    require(
        pane.argv_digest()
            == &reconnect::argv_digest(&[CHILD_PROGRAM, "--pane-exit", &paired, &record])?
            && command.argv_digest() == &reconnect::argv_digest(&["bash", "-c", held_command()])?
            && command.parent() == pane.pid(),
        "same native wrapper's actual original command child, not its sleep grandchild",
    )
}
impl Drop for Observer {
    fn drop(&mut self) {
        if !self.closed {
            std::mem::forget((self.reader.take(), self.runtime.take(), self.cli.take()));
        }
    }
}
