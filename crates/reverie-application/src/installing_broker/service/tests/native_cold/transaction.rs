use super::*;
use reverie_host::{
    engine_metadata::EngineBootstrap, installed_worker_engine::InstalledWorkerEngine,
    worker_runtime::WorkerRuntime,
};
use std::collections::BTreeMap;
mod exchange;
use exchange::Frames;

pub(super) struct Attempt {
    pub tenant: Tenant,
    inputs: Inputs,
    cli: Cli,
    end: Instant,
    broker: Option<Arc<InstallingBroker>>,
    service: Option<BrokerService>,
    startup_failure: Option<Box<BrokerStartupFailure>>,
    bootstrap_failure: Option<Box<crate::installing_broker::BrokerBootstrapFailure>>,
    service_failure: Option<Box<BrokerServiceFailure>>,
    client: Option<UnixStream>,
    create_attempted: bool,
    server: Option<String>,
    worker: Option<String>,
    home: Option<PathBuf>,
    stopped: bool,
    complete: bool,
}
impl Attempt {
    pub(super) fn new(inputs: Inputs) -> Result<Self> {
        let tenant = Tenant::new(&inputs)?;
        let end = Instant::now() + Duration::from_secs(150);
        let cli = Cli::new(inputs.docker.clone(), tenant.root.clone(), end);
        Ok(Self {
            tenant,
            inputs,
            cli,
            end,
            broker: None,
            service: None,
            startup_failure: None,
            bootstrap_failure: None,
            service_failure: None,
            client: None,
            create_attempted: false,
            server: None,
            worker: None,
            home: None,
            stopped: false,
            complete: false,
        })
    }
    pub(super) fn run(&mut self) -> Result<()> {
        self.bootstrap()?;
        self.create_anchor()?;
        self.start_service()?;
        self.cold_launch()?;
        self.stop_via_service()?;
        self.assert_released()
    }
    fn broker(&self) -> &Arc<InstallingBroker> {
        self.broker.as_ref().expect("original broker")
    }
    fn bootstrap(&mut self) -> Result<()> {
        let snapshot = crate::worker_validation::load_owner_config(&self.tenant.source)
            .map_err(|e| e.to_string())?;
        let mut env: BTreeMap<_, _> = std::env::vars_os().collect();
        for name in ["DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"] {
            env.remove(std::ffi::OsStr::new(name));
        }
        env.insert("DOCKER_HOST".into(), "unix:///var/run/docker.sock".into());
        env.insert(
            "DOCKER_CONFIG".into(),
            self.tenant.root.join("docker-config").into_os_string(),
        );
        let engine = EngineBootstrap::from_service(
            self.inputs.docker.as_os_str(),
            env,
            self.tenant.root.clone(),
        )
        .map_err(|e| e.to_string())?;
        let runtime = WorkerRuntime::new(
            InstalledWorkerEngine::new(engine),
            snapshot.envelope().base(),
        );
        let broker = match InstallingBroker::new(snapshot, runtime) {
            Ok(broker) => Arc::new(broker),
            Err(failure) => {
                let error = failure.to_string();
                self.bootstrap_failure = Some(failure);
                return Err(error);
            }
        };
        self.broker = Some(broker.clone());
        require(
            broker
                .resource_reservations()
                .map_err(|e| e.to_string())?
                .is_some(),
            "real R Gate is mandatory",
        )?;
        // This is the real readonly qualifier, not parsed profile permission.
        // Its actual immutable/native query owners must close before effects.
        let qualified = broker
            .qualify_worker_image(
                self.inputs.base.clone(),
                self.inputs.annex.clone(),
                self.inputs.image.clone(),
                self.end,
            )
            .map_err(|failure| {
                let cause = failure.to_string();
                std::mem::forget(failure);
                cause
            })?;
        qualified.close(self.end).map_err(|failure| {
            let cause = failure.to_string();
            std::mem::forget(failure);
            cause
        })
    }
    fn create_anchor(&mut self) -> Result<()> {
        require(!self.create_attempted, "anchor create is one-shot")?;
        self.create_attempted = true;
        let home = format!(
            "type=bind,source={},target=/home/agent",
            self.tenant.root.join("anchor-home").display()
        );
        let work = format!(
            "type=bind,source={},target=/workspace",
            self.tenant.root.join("work").display()
        );
        let office = format!(
            "type=bind,source={},target=/run/reverie-office,readonly",
            self.tenant
                .root
                .join("office")
                .join(self.tenant.sid.as_str())
                .display()
        );
        let label = format!("reverie.cold-fixture={}", self.tenant.sid.as_str());
        let raw = self.cli.success(&[
            "create",
            "--name",
            &self.tenant.server,
            "--label",
            &label,
            "--user",
            "1000:100",
            "--init",
            "--network",
            "none",
            "--memory",
            "512m",
            "--memory-swap",
            "512m",
            "--pids-limit",
            "128",
            "--read-only",
            "--mount",
            &home,
            "--mount",
            &work,
            "--mount",
            &office,
            "--entrypoint",
            "/bin/sleep",
            self.inputs.image.as_str(),
            "infinity",
        ])?;
        let id = raw.trim();
        require(
            id.len() == 64
                && id
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()),
            "actual full anchor CID required",
        )?;
        self.server = Some(id.to_owned());
        self.anchor_current(false)?;
        let id = self.server.clone().expect("original created CID");
        self.cli.success(&["start", &id])?;
        self.anchor_current(true)
    }
    fn anchor_current(&mut self, running: bool) -> Result<()> {
        let id = self.server.as_ref().ok_or("actual anchor missing")?.clone();
        let row = self.inspect(&id)?;
        outside_production_pool(&row)?;
        require(
            row["Id"] == id
                && row["Name"] == format!("/{}", self.tenant.server)
                && row["Image"] == self.inputs.image.as_str()
                && row["Config"]["Labels"]["reverie.cold-fixture"] == self.tenant.sid.as_str()
                && row["State"]["Running"].as_bool() == Some(running)
                && row["State"]["Pid"]
                    .as_u64()
                    .is_some_and(|pid| (pid > 0) == running),
            "same owned anchor identity/state changed",
        )
    }
    fn start_service(&mut self) -> Result<()> {
        let startup = match self.broker().prepare_shared_service() {
            Ok(startup) => startup,
            Err(failure) => {
                let error = failure.to_string();
                self.startup_failure = Some(failure);
                return Err(error);
            }
        };
        match startup.bind_listener() {
            Ok(service) => {
                self.service = Some(service);
                Ok(())
            }
            Err(failure) => {
                let error = failure.to_string();
                self.startup_failure = Some(failure);
                Err(error)
            }
        }
    }
    fn cold_launch(&mut self) -> Result<()> {
        let raw=self.request("printf 'native-cold-canary-started\\n'; for ((i=0;i<600;i++)); do if test -f /workspace/release; then printf 'native-cold-canary-ok\\n'; exit 0; fi; sleep .1; done; exit 79");
        self.client = Some(exchange::connect(
            &self.tenant.root.join("broker/service.sock"),
            b'J',
            &raw,
        )?);
        let mut frames = Frames::default();
        self.until(&mut frames, true)?;
        self.capture_started()?;
        self.bare_record()?;
        tenant::write(
            &self.tenant.root.join("work/release"),
            b"release only this fixed finite workload",
        )?;
        self.until(&mut frames, false)?;
        require(
            frames.errors.is_empty()
                && frames.exit.as_deref() == Some(b"0")
                && frames
                    .output
                    .windows(b"native-cold-canary-ok".len())
                    .any(|v| v == b"native-cold-canary-ok")
                && frames.eof,
            "actual native pane receipt/output/EOF required",
        )?;
        nix::unistd::close(self.client.take().expect("original client"))
            .map_err(|e| e.to_string())?;
        self.require_exit()
    }
    fn request(&self, command: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({"sessionId":self.tenant.sid.as_str(),"cwd":"/workspace","command":command,"env":{},"cols":80,"rows":24,"attachOnly":false})).expect("fixed fixture request")
    }
    fn capture_started(&mut self) -> Result<()> {
        let (cid, home) = {
            let life = self
                .broker()
                .installed
                .lifecycle()
                .map_err(|e| e.to_string())?;
            let entry = life
                .guard
                .iter()
                .find(|entry| entry.session == self.tenant.sid)
                .ok_or("actual Started registration required")?;
            let crate::installing_broker::LaptopOwner::Started(owner) = &entry.owner else {
                return Err("COLD must mint actual Started, never recovered/reuse".into());
            };
            (
                owner
                    .created
                    .container_id()
                    .ok_or("actual Created CID")?
                    .as_str()
                    .to_owned(),
                owner.network.paths().home().to_owned(),
            )
        };
        self.worker = Some(cid.clone());
        self.home = Some(home);
        let row = self.inspect(&cid)?;
        outside_production_pool(&row)?;
        require(
            row["Name"] == format!("/{}", self.tenant.name())
                && row["Image"] == self.inputs.image.as_str()
                && row["Config"]["Labels"]["reverie.worker"] == self.tenant.deployment
                && row["Config"]["Labels"]["reverie.session"] == self.tenant.sid.as_str(),
            "actual product-created worker identity",
        )?;
        self.r_available()?;
        match reverie_host::worker_storage::StorageLease::acquire_launch(
            &self.tenant.config,
            &self.tenant.sid,
        ) {
            Err(_) => Ok(()),
            Ok(lease) => {
                lease.close().map_err(|e| e.to_string())?;
                Err("actual live Started lease must remain owned".into())
            }
        }
    }
    fn bare_record(&mut self) -> Result<()> {
        self.anchor_current(true)?;
        let nonce = reverie_host::resource_facts::fresh_owner_nonce().map_err(|e| e.to_string())?;
        let name = format!("{}.json", nonce.as_str());
        let request = reverie_contracts::worker_launch::WorkerRequest::decode(
            &self.request("printf native-bare-record-ok; exit 0"),
            &self.tenant.config,
        )
        .map_err(|e| e.to_string())?;
        let host = self
            .tenant
            .root
            .join("anchor-home/.reverie-launch")
            .join(&name);
        tenant::write(
            &host,
            &reverie_contracts::worker_child::encode_launch_record(&request),
        )?;
        let guest = format!("/home/agent/.reverie-launch/{name}");
        let id = self.server.clone().expect("original anchor CID");
        let output = self
            .cli
            .success(&["exec", &id, "/bin/reverie-worker-child", &guest])?;
        require(
            output.contains("native-bare-record-ok") && missing(&host)?,
            "actual bare RECORD compatibility and one-shot consume",
        )?;
        self.anchor_current(true)
    }
    fn require_exit(&self) -> Result<()> {
        let runtime = fs::read(
            self.tenant
                .root
                .join("state")
                .join(self.tenant.sid.as_str())
                .join("runtime.json"),
        )
        .map_err(|e| e.to_string())?;
        let data = reverie_contracts::broker_laptop::LaunchRuntimeData::decode_read_text(&runtime)
            .map_err(|e| e.to_string())?;
        let name = data
            .exit()
            .codepoints()
            .iter()
            .map(|c| char::from_u32(*c))
            .collect::<Option<String>>()
            .ok_or("fixture exit path must be scalar")?;
        require(
            !Path::new(&name).is_absolute() && !name.contains('/'),
            "actual paired exit leaf only",
        )?;
        let raw = fs::read(
            self.home
                .as_ref()
                .ok_or("same actual storage home")?
                .join(".reverie-launch")
                .join(name),
        )
        .map_err(|e| e.to_string())?;
        require(raw == b"0" || raw == b"0\n", "actual native .exit0 receipt")
    }
    fn stop_via_service(&mut self) -> Result<()> {
        let before = self
            .broker()
            .installed
            .lifecycle()
            .map_err(|e| e.to_string())?
            .guard
            .iter()
            .any(|v| v.session == self.tenant.sid);
        let mut socket = exchange::connect(
            &self.tenant.root.join("broker/service.sock"),
            b'C',
            br#"{"action":"stop-laptops"}"#,
        )?;
        let mut frames = Frames::default();
        while !frames.eof {
            if Instant::now() >= self.end {
                std::mem::forget(socket);
                return Err("original C cleanup deadline, owner retained".into());
            }
            self.service
                .as_ref()
                .expect("actual service")
                .poll_handler()
                .map_err(|e| e.to_string())?;
            frames.read(&mut socket)?;
        }
        nix::unistd::close(socket).map_err(|e| e.to_string())?;
        require(
            frames.errors.is_empty()
                && frames.replies.iter().any(|raw| {
                    serde_json::from_slice::<serde_json::Value>(raw)
                        .ok()
                        .is_some_and(|v| {
                            v == serde_json::json!({"action":"stop-laptops","success":true})
                        })
                }),
            "actual C response and closed channel",
        )?;
        self.joined()?;
        tenant::write(&self.tenant.root.join("owned-stop-path.json"),&serde_json::to_vec(&serde_json::json!({"registeredBeforeControl":before,"path":if before{"normal supervisor/C boundary"}else{"supervisor completed before control"}})).map_err(|e|e.to_string())?)?;
        let id = self.worker.clone().ok_or("actual original worker CID")?;
        let row = self.inspect(&id)?;
        require(
            row["Id"] == id
                && row["State"]["Running"] == false
                && row["State"]["Pid"].as_u64() == Some(0),
            "same owned worker physically stopped",
        )?;
        self.stopped = true;
        self.assert_released()
    }
    fn assert_released(&self) -> Result<()> {
        require(
            self.broker()
                .installed
                .lifecycle()
                .map_err(|e| e.to_string())?
                .guard
                .is_empty(),
            "all owned laptop registrations released",
        )?;
        let lease = reverie_host::worker_storage::StorageLease::acquire_launch(
            &self.tenant.config,
            &self.tenant.sid,
        )
        .map_err(|e| e.to_string())?;
        lease.close().map_err(|e| e.to_string())?;
        self.r_available()?;
        require(
            missing(
                &self
                    .tenant
                    .root
                    .join("office")
                    .join(self.tenant.sid.as_str())
                    .join("office.sock"),
            )?,
            "same Office phone/socket must close",
        )
    }
    fn r_available(&self) -> Result<()> {
        let config = reverie_contracts::reservation_engine::ReservationConfiguration::capture(
            self.tenant.config.clone(),
        );
        let mut lock = reverie_host::reservation_control::AdmissionLock::acquire(&config)
            .map_err(|e| e.to_string())?;
        lock.close().map_err(|e| e.to_string())
    }
    fn inspect(&mut self, id: &str) -> Result<serde_json::Value> {
        serde_json::from_str(
            &self
                .cli
                .success(&["inspect", "--format", "{{json .}}", id])?,
        )
        .map_err(|e| e.to_string())
    }
    pub(super) fn cleanup(&mut self) -> Result<()> {
        if !self.cli.known() {
            return Err("original CLI unknown; no speculative cleanup".into());
        }
        if !self.stopped {
            return Err(
                "actual same-owner stop not proven; retain service/worker/server/root".into(),
            );
        }
        self.broker().request_stop();
        if let Some(service) = self.service.take() {
            match service.run() {
                Ok(_) => (),
                Err(failure) => {
                    let error = failure.to_string();
                    self.service_failure = Some(failure);
                    return Err(error);
                }
            }
        }
        let worker = self.worker.clone().ok_or("original worker CID")?;
        let row = self.inspect(&worker)?;
        require(
            row["Id"] == worker
                && row["State"]["Running"] == false
                && row["State"]["Pid"].as_u64() == Some(0),
            "same original stopped worker before nonforce remove",
        )?;
        self.cli.success(&["rm", &worker])?;
        self.anchor_current(true)?;
        let anchor = self.server.clone().expect("original anchor");
        self.cli.success(&["stop", "--time", "5", &anchor])?;
        self.anchor_current(false)?;
        self.cli.success(&["rm", &anchor])?;
        for id in [&worker, &anchor] {
            require(
                self.cli
                    .success(&["ps", "-aq", "--no-trunc", "--filter", &format!("id={id}")])?
                    .trim()
                    .is_empty(),
                "fresh exact original CID absence",
            )?;
        }
        self.complete = true;
        println!(
            "REAL_NATIVE_COLD_J_OK R=enabled child=pane-exit+bare-record EOF=known stop=owned leases=closed service=closed root={}",
            self.tenant.root.display()
        );
        Ok(())
    }
}
fn require(value: bool, message: &str) -> Result<()> {
    if value { Ok(()) } else { Err(message.into()) }
}
fn missing(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(e) => Err(e.to_string()),
        Ok(_) => Ok(false),
    }
}
fn outside_production_pool(row: &serde_json::Value) -> Result<()> {
    require(
        row["HostConfig"]["CgroupParent"].as_str() == Some(""),
        "admission fixture must use Docker's unmanaged default parent",
    )?;
    if let Some(pid) = row["State"]["Pid"].as_u64().filter(|pid| *pid > 0) {
        let raw = fs::read_to_string(format!("/proc/{pid}/cgroup")).map_err(|e| e.to_string())?;
        let unified = raw
            .lines()
            .filter_map(|line| line.strip_prefix("0::"))
            .collect::<Vec<_>>();
        require(
            unified.len() == 1
                && !unified[0]
                    .split('/')
                    .any(|part| part.ends_with("-workers.slice")),
            "private fixture must never enter the production worker parent",
        )?;
    }
    Ok(())
}
impl Drop for Attempt {
    fn drop(&mut self) {
        if !self.complete {
            std::mem::forget((
                self.broker.take(),
                self.service.take(),
                self.startup_failure.take(),
                self.bootstrap_failure.take(),
                self.service_failure.take(),
                self.client.take(),
            ));
        }
    }
}
