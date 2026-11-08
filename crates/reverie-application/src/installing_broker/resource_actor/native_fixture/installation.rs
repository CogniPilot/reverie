//! Trusted, private owning-test installation from actual Docker/Nix bytes.
//! These selected DATA never substitute for any production native/Q guard.
use super::*;
use reverie_contracts::{
    reservation_control,
    resource_actor::{EngineMetadata, ProcessStatData, WebsiteImageProvenance},
    worker_config,
};
use std::ffi::OsString;

impl Fixture {
    pub(super) fn create() -> CaseResult<Self> {
        require(
            nix::unistd::getuid().as_raw() == 1000 && nix::unistd::getgid().as_raw() == 100,
            "fixture requires ordinary UID1000:GID100",
        )?;
        let tree = Tree::new();
        for name in [
            "run",
            "guest",
            "guest/home",
            "guest/tmp",
            "guest/data",
            "guest/instance",
            "guest/cases",
            "guest/workspace",
            "guest/attachments",
            "office",
            "scratch",
            "company",
        ] {
            fs::create_dir(tree.root.join(name)).map_err(reason)?;
            fs::set_permissions(tree.root.join(name), fs::Permissions::from_mode(0o700))
                .map_err(reason)?;
        }
        let listener = UnixListener::bind(tree.root.join("run/q.sock")).map_err(reason)?;
        fs::set_permissions(
            tree.root.join("run/q.sock"),
            fs::Permissions::from_mode(0o600),
        )
        .map_err(reason)?;
        listener.set_nonblocking(true).map_err(reason)?;
        let mut owner = Self {
            tree: Some(tree),
            http: Http::new()?,
            listener,
            cid: String::new(),
            port: 0,
            closed: false,
        };
        owner.create_container()?;
        owner.install_facts()?;
        Ok(owner)
    }
    fn name(&self) -> String {
        format!(
            "nativeq-{}",
            self.tree().root.file_name().unwrap().to_str().unwrap()
        )
    }
    fn image() -> CaseResult<String> {
        let image = std::env::var("REVERIE_NATIVE_Q_IMAGE").map_err(reason)?;
        require(
            image.strip_prefix("sha256:").is_some_and(|s| {
                s.len() == 64
                    && s.bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            }),
            "exact immutable fixture image required",
        )?;
        Ok(image)
    }
    fn create_container(&mut self) -> CaseResult<()> {
        let image = Self::image()?;
        let observed = self
            .http
            .docker("GET", &format!("/images/{image}/json"), None)?;
        let provenance = artifact("REVERIE_NATIVE_Q_PROVENANCE")?;
        EngineMetadata::decode(&serde_json::to_vec(&observed).map_err(reason)?)
            .map_err(reason)?
            .qualify_image(
                &WebsiteImageProvenance::decode(&fs::read(&provenance).map_err(reason)?)
                    .map_err(reason)?,
            )
            .map_err(reason)?;
        require(
            observed["Config"]["User"] == "1000:100",
            "actual fixture image user changed",
        )?;
        self.tree().write(
            "fixture-owner.json",
            &serde_json::to_vec(
                &json!({"phase":"CREATE_ATTEMPT","name":self.name(),"image":image}),
            )
            .map_err(reason)?,
        );
        let body = json!({"Image":image,"User":"1000:100","Env":observed["Config"]["Env"],"Entrypoint":observed["Config"]["Entrypoint"],"Cmd":[],"WorkingDir":"/fixture","Labels":{"reverie.native-q-fixture":self.name()},
            "ExposedPorts":{"3000/tcp":{}},"HostConfig":{"AutoRemove":false,"Init":false,"Privileged":false,"ReadonlyRootfs":true,"CapDrop":["ALL"],"CapAdd":[],"SecurityOpt":["no-new-privileges"],"PidMode":"","Memory":536870912u64,"MemorySwap":536870912u64,"PidsLimit":256,"NanoCpus":0,"CpusetCpus":"0-7",
                "PortBindings":{"3000/tcp":[{"HostIp":"127.0.0.1","HostPort":""}]},"Mounts":[
                    {"Type":"bind","Source":self.tree().root.join("run"),"Target":"/run/reverie-native-q","ReadOnly":true,"BindOptions":{"CreateMountpoint":false}},
                    {"Type":"bind","Source":self.tree().root.join("guest"),"Target":"/fixture","ReadOnly":false,"BindOptions":{"CreateMountpoint":false}}]}});
        let created = self.http.docker(
            "POST",
            &format!("/containers/create?name={}", self.name()),
            Some(&body),
        )?;
        let cid = created["Id"]
            .as_str()
            .ok_or_else(|| "fixture original CID absent".to_owned())?;
        require(
            cid.len() == 64
                && cid
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "fixture original CID malformed",
        )?;
        self.cid = cid.to_owned();
        self.tree().write(
            "fixture-created.json",
            &serde_json::to_vec(&json!({"cid":self.cid,"name":self.name(),"image":image}))
                .map_err(reason)?,
        );
        self.http
            .docker("POST", &format!("/containers/{}/start", self.cid), None)?;
        let item = self.container()?;
        let bindings = item["NetworkSettings"]["Ports"]["3000/tcp"]
            .as_array()
            .ok_or_else(|| "fixture loopback port missing".to_owned())?;
        require(
            bindings.len() == 1 && bindings[0]["HostIp"] == "127.0.0.1",
            "fixture port escaped loopback",
        )?;
        self.port = bindings[0]["HostPort"]
            .as_str()
            .ok_or_else(|| "fixture port malformed".to_owned())?
            .parse()
            .map_err(reason)?;
        self.wait_ended()
    }
    pub(super) fn container(&self) -> CaseResult<Value> {
        let item = self
            .http
            .docker("GET", &format!("/containers/{}/json", self.cid), None)?;
        require(
            item["Id"] == self.cid
                && item["Name"] == format!("/{}", self.name())
                && item["Config"]["Labels"]["reverie.native-q-fixture"] == self.name(),
            "fixture original native identity changed",
        )?;
        Ok(item)
    }
    fn install_facts(&mut self) -> CaseResult<()> {
        self.write_company(None)?;
        let item = self.container()?;
        let info = self.http.docker("GET", "/info", None)?;
        require(info["OSType"] == "linux", "actual Linux engine required")?;
        let socket = fs::symlink_metadata("/var/run/docker.sock").map_err(reason)?;
        let provenance_path = artifact("REVERIE_NATIVE_Q_PROVENANCE")?;
        let client_path = artifact("REVERIE_NATIVE_Q_CLIENT_MANIFEST")?;
        let provenance: Value =
            serde_json::from_slice(&fs::read(&provenance_path).map_err(reason)?).map_err(reason)?;
        let client: Value =
            serde_json::from_slice(&fs::read(&client_path).map_err(reason)?).map_err(reason)?;
        let mut config: Value = serde_json::from_slice(&self.tree().raw).map_err(reason)?;
        config["uid"] = json!(1000);
        config["gid"] = json!(100);
        config["budgetMode"] = json!("admission");
        config["memoryMiB"] = json!(512);
        config["image"] = json!(Self::image()?);
        config["serverContainer"] = json!(self.name());
        config["socket"] = json!(self.tree().root.join("run/q.sock"));
        config["deployment"] = json!(self.name());
        config["resourceActorConfig"] = json!(self.tree().root.join("control/resource-actor.json"));
        let tree = self.tree.as_mut().expect("owned fixture root");
        tree.raw = serde_json::to_vec(&config).map_err(reason)?;
        tree.write("worker.json", &tree.raw);
        // Reuse the exact owned R bootstrap marker producer; no live baseline
        // or profile, journal claim, capacity credit or policy is manufactured.
        let checked =
            worker_config::decode(&serde_json::to_vec(&config).map_err(reason)?).map_err(reason)?;
        tree.marker(&config);
        let pid = item["State"]["Pid"]
            .as_u64()
            .ok_or_else(|| "actual website init absent".to_owned())?;
        let stat = ProcessStatData::decode(&fs::read(format!("/proc/{pid}/stat")).map_err(reason)?)
            .map_err(reason)?;
        let mut host = item["HostConfig"].clone();
        host["OomKillDisable"] = json!(false);
        let mut mounts = item["Mounts"]
            .as_array()
            .ok_or_else(|| "actual mounts absent".to_owned())?
            .clone();
        mounts.sort_by(|a, b| a["Destination"].as_str().cmp(&b["Destination"].as_str()));
        let facts = json!({"version":2,"purpose":"resource-replacement-v1","configurationDigest":reservation_control::domain_digest(&checked).map_err(reason)?.to_hex(),
            "engine":{"socket":"/var/run/docker.sock","identity":[socket.dev(),socket.ino(),u64::from(socket.uid()),u64::from(socket.gid())],"id":info["ID"]},
            "imageProvenance":{"path":provenance_path,"sha256":file_sha(&provenance_path)?},"client":{"path":client_path,"sha256":file_sha(&client_path)?},
            "website":{"containerId":self.cid,"imageId":item["Image"],"configDigest":ascii_digest(&item["Config"])? ,"hostConfigDigest":ascii_digest(&host)?,"mountsDigest":ascii_digest(&json!(mounts))?,"initPid":pid,"initStart":stat.start().to_u64().ok_or_else(||"actual start tick outside u64".to_owned())?,"uid":1000,"gid":100,
                "bootstrap":{"executable":client["executable"],"argv":[client["executable"]]},"node":{"executable":provenance["node"]["executable"],"argv":item["Config"]["Entrypoint"]},"codeFiles":provenance["codeFiles"]}});
        let raw = serde_json::to_vec(&facts).map_err(reason)?;
        let document = InstalledFactsDocument::decode(&raw).map_err(reason)?;
        // This only cross-checks selected DATA against the actual bootstrap
        // response. The factory must independently repeat all native guards.
        EngineMetadata::decode(&serde_json::to_vec(&item).map_err(reason)?)
            .map_err(reason)?
            .qualify_website(&document.website)
            .map_err(reason)?;
        self.tree().write("control/resource-actor.json", &raw);
        self.tree().write("fixture-native-observations.json",&serde_json::to_vec(&json!({"container":item,"engineId":info["ID"],"initCgroup":fs::read_to_string(format!("/proc/{pid}/cgroup")).map_err(reason)?,"initStatus":fs::read_to_string(format!("/proc/{pid}/status")).map_err(reason)?})).map_err(reason)?);
        self.physical("before")?;
        Ok(())
    }
    pub(super) fn broker(&self) -> CaseResult<InstallingBroker> {
        let snapshot = load_owner_config(&self.tree().root.join("worker.json")).map_err(reason)?;
        let program = artifact("REVERIE_NATIVE_Q_DOCKER")?;
        let environment = BTreeMap::from([
            (
                OsString::from("DOCKER_HOST"),
                OsString::from("unix:///var/run/docker.sock"),
            ),
            (
                OsString::from("HOME"),
                self.tree().root.as_os_str().to_owned(),
            ),
        ]);
        let bootstrap = EngineBootstrap::from_service(
            program.as_os_str(),
            environment,
            self.tree().root.clone(),
        )
        .map_err(reason)?;
        let runtime = WorkerRuntime::new(
            InstalledWorkerEngine::new(bootstrap),
            snapshot.envelope().base(),
        );
        InstallingBroker::new(snapshot, runtime).map_err(reason)
    }
    pub(super) fn cleanup_known(&mut self) -> CaseResult<()> {
        self.wait_ended()?;
        let item = self.container()?;
        if item["State"]["Running"] == true {
            self.http
                .docker("POST", &format!("/containers/{}/stop?t=5", self.cid), None)?;
        }
        require(
            self.container()?["State"]["Running"] == false,
            "owned Node stop unconfirmed",
        )?;
        self.http.docker(
            "DELETE",
            &format!("/containers/{}?v=false&force=false", self.cid),
            None,
        )?;
        self.closed = true;
        Ok(())
    }
}
fn artifact(name: &str) -> CaseResult<PathBuf> {
    let path =
        PathBuf::from(std::env::var_os(name).ok_or_else(|| format!("explicit {name} required"))?);
    require(
        path.is_absolute()
            && path.starts_with("/nix/store")
            && fs::canonicalize(&path).map_err(reason)? == path,
        "canonical Nix input required",
    )?;
    Ok(path)
}
fn file_sha(path: &Path) -> CaseResult<String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(fs::read(path).map_err(reason)?)
    ))
}
fn ascii_digest(value: &Value) -> CaseResult<String> {
    // Only this fixture's finite ASCII Docker selection. Independent production
    // codecs recompute/compare every digest from actual engine responses.
    let raw = serde_json::to_vec(value).map_err(reason)?;
    require(raw.is_ascii(), "fixture selection must remain ASCII")?;
    Ok(format!("{:x}", Sha256::digest(raw)))
}
