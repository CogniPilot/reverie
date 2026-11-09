//! Explicitly requested integration control. Never targets a registered office.
use super::*;
use crate::engine::Engine;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    net::TcpListener,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

struct Fixture {
    root: PathBuf,
    name: String,
    port: u16,
    engine: Engine,
    ids: Vec<String>,
    names: BTreeSet<String>,
}
impl Fixture {
    fn capture() -> Result<Self> {
        require(
            nix::unistd::geteuid().as_raw() == 1000,
            "FIXTURE_REQUIRES_UID_1000",
        )?;
        let mut random = [0; 16];
        getrandom::getrandom(&mut random).map_err(|_| DeploymentError::new("FIXTURE_RANDOM"))?;
        let suffix = random
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let root = std::env::temp_dir().join(format!("reverie-deployment-fixture-{suffix}"));
        fs::create_dir(&root)?;
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
        for name in ["data", "home", "data/console"] {
            fs::create_dir(root.join(name))?;
        }
        let port = TcpListener::bind("127.0.0.1:0")?.local_addr()?.port();
        let name = format!("reverie-native-fixture-{suffix}");
        crate::installation::exclusive_json(
            &root.join("fixture-owner.json"),
            &json!({"fixture":suffix,"name":name}),
        )?;
        crate::installation::exclusive_json(
            &root.join("deployment.json"),
            &json!({"version":1,"containerName":name,"port":port,"websiteRuntime":"default"}),
        )?;
        fs::write(
            root.join("data/console/unknown-binary-extension"),
            [0, 255, 42, 0, 128],
        )?;
        fs::write(
            root.join("data/console/unicode-marker"),
            "retained café \u{2603}\0\n",
        )?;
        eprintln!("owned deployment fixture preserved at {}", root.display());
        let names = BTreeSet::from([format!("/{name}")]);
        Ok(Self {
            root,
            name,
            port,
            engine: Engine::new(Path::new("/var/run/docker.sock"))?,
            ids: Vec::new(),
            names,
        })
    }
    fn create_old(&mut self, image: &str, native_source: bool) -> Result<()> {
        let previous = self.engine.image(image)?;
        require(previous["Id"] == image, "FIXTURE_IMAGE_CHANGED")?;
        let body = self.body(&previous, native_source)?;
        let created = self.engine.json(
            "POST",
            &format!("/containers/create?name={}", self.name),
            Some(&body),
        )?;
        let id = crate::model::cid(crate::model::string(&created, "Id")?)?.to_owned();
        self.ids.push(id.clone());
        self.persist("old-created", &json!({"id":id}))?;
        let actual = self.engine.container(&id)?;
        require(
            model::uses_front(&actual["Config"])? == native_source,
            "FIXTURE_SOURCE_MODE_CHANGED",
        )?;
        require(
            actual["HostConfig"]["CpusetCpus"] == body["HostConfig"]["CpusetCpus"],
            "FIXTURE_CPU_AFFINITY_CHANGED",
        )?;
        self.engine.start(&id)
    }
    fn body(&self, image: &Value, native_source: bool) -> Result<Value> {
        let affinity = driver_cpu_affinity()?;
        let mut env = BTreeMap::new();
        for entry in image["Config"]["Env"]
            .as_array()
            .ok_or_else(|| DeploymentError::new("FIXTURE_ENV"))?
        {
            let entry = entry
                .as_str()
                .ok_or_else(|| DeploymentError::new("FIXTURE_ENV"))?;
            let (key, _) = entry
                .split_once('=')
                .ok_or_else(|| DeploymentError::new("FIXTURE_ENV"))?;
            env.insert(key.to_owned(), entry.to_owned());
        }
        for (key, value) in [
            ("HOME", "/home/agent"),
            ("TMPDIR", "/home/agent/tmp"),
            ("REVERIE_SHARED_WORKSPACE_PATH", "/home/agent/workspace"),
            (
                "REVERIE_SHARED_ATTACHMENTS_PATH",
                "/home/agent/workspace/attachments",
            ),
            ("REVERIE_DATA", "/instances/default"),
            ("REVERIE_DATA_DIR", "/instances/default/console"),
            ("REVERIE_INSTALL_CLIS", "none"),
            ("REVERIE_KOKORO_ENABLED", "0"),
            ("REVERIE_PASSWORD", "owned-fixture-not-a-live-secret"),
            (
                "REVERIE_WORKER_SOCKET",
                "/run/reverie-fixture-no-worker.sock",
            ),
        ] {
            env.insert(key.into(), format!("{key}={value}"));
        }
        for key in ["REVERIE_FRONT_CHILD", "REVERIE_NATIVE_FRONT_BIN"] {
            require(!env.contains_key(key), "FIXTURE_OLD_SELECTS_FRONT")?;
        }
        model::uses_front(&image["Config"])?;
        if native_source {
            // This test models an existing deployment's explicit selection even
            // when its original image predates the default native-front flag.
            env.insert(
                "REVERIE_NATIVE_FRONT".into(),
                "REVERIE_NATIVE_FRONT=1".into(),
            );
        } else {
            require(
                !env.contains_key("REVERIE_NATIVE_FRONT"),
                "FIXTURE_OLD_SELECTS_FRONT",
            )?;
        }
        let mounts = [("data","/instances/default"),("home","/home/agent")].into_iter().map(|(source,target)|json!({
            "Type":"bind","Source":self.root.join(source),"Target":target,"ReadOnly":false,"BindOptions":{"CreateMountpoint":false}
        })).collect::<Vec<_>>();
        Ok(
            json!({"Image":image["Id"],"User":"1000:100","Env":env.into_values().collect::<Vec<_>>(),
            "Entrypoint":image["Config"]["Entrypoint"],"Cmd":image["Config"]["Cmd"],
            "ExposedPorts":{"3000/tcp":{}},"HostConfig":{"Mounts":mounts,"NetworkMode":"bridge","AutoRemove":false,
                "Init":true,"Memory":536870912u64,"MemorySwap":536870912u64,"PidsLimit":256,"CpusetCpus":affinity,
                "PortBindings":{"3000/tcp":[{"HostIp":"127.0.0.1","HostPort":self.port.to_string()}]}}}),
        )
    }
    fn persist(&self, phase: &str, value: &Value) -> Result<()> {
        crate::installation::exclusive_json(&self.root.join(format!("fixture-{phase}.json")), value)
    }
    fn run(&mut self, candidate: &str) -> Result<()> {
        let mut service = DeploymentService::capture(&self.root)?;
        let result = self.run_service(&service, candidate);
        DeploymentError::finalized(result, service.close())
    }
    fn run_service(&mut self, service: &DeploymentService, candidate: &str) -> Result<()> {
        let operation = self.apply_candidate(service, candidate, "")?;
        self.return_operation(service, &operation, "")
    }
    fn apply_candidate(
        &mut self,
        service: &DeploymentService,
        candidate: &str,
        receipts: &str,
    ) -> Result<String> {
        let selected = self.engine.container(&self.name)?;
        let old = model::cid(model::string(&selected, "Id")?)?.to_owned();
        require(self.ids.contains(&old), "FIXTURE_SOURCE_NOT_OWNED")?;
        service.await_ready(&old, model::uses_front(&selected["Config"])?)?;
        let preview = service.preview(candidate)?;
        let prefix = self.name.chars().take(24).collect::<String>();
        for phase in ["candidate", "before-front", "failed-front"] {
            self.names
                .insert(format!("/{prefix}-{phase}-{}", &preview.operation[..16]));
        }
        self.persist(
            &format!("{receipts}preview"),
            &serde_json::to_value(&preview)?,
        )?;
        let prepared = service.prepare(&preview.operation)?;
        let id = prepared
            .candidate_id
            .clone()
            .ok_or_else(|| DeploymentError::new("FIXTURE_CANDIDATE_MISSING"))?;
        self.ids.push(id);
        self.candidate_is_isolated()?;
        self.persist(
            &format!("{receipts}prepared"),
            &serde_json::to_value(&prepared)?,
        )?;
        require(prepared.stage == "PREPARED", "FIXTURE_PREPARE_UNCONFIRMED")?;
        let applied = service.apply(&preview.operation)?;
        self.persist(
            &format!("{receipts}applied"),
            &serde_json::to_value(&applied)?,
        )?;
        require(applied.stage == "HYBRID_READY", "FIXTURE_APPLY_UNCONFIRMED")?;
        self.unchanged()?;
        Ok(preview.operation)
    }
    fn return_operation(
        &self,
        service: &DeploymentService,
        operation: &str,
        receipts: &str,
    ) -> Result<()> {
        let returned = service.rollback(operation)?;
        self.persist(
            &format!("{receipts}returned"),
            &serde_json::to_value(&returned)?,
        )?;
        require(returned.stage == "RESTORED", "FIXTURE_RETURN_UNCONFIRMED")?;
        require(
            service.status(operation)?.stage == "RESTORED",
            "FIXTURE_RETURN_STATUS_UNCONFIRMED",
        )?;
        self.unchanged()
    }
    fn run_repeated(&mut self, candidate: &str) -> Result<()> {
        let mut service = DeploymentService::capture(&self.root)?;
        let result = self.run_repeated_service(&service, candidate);
        DeploymentError::finalized(result, service.close())
    }
    fn run_repeated_service(&mut self, service: &DeploymentService, candidate: &str) -> Result<()> {
        let first = self.apply_candidate(service, candidate, "")?;
        let second = self.apply_candidate(service, candidate, "second-")?;
        require(
            service.status(&first)?.stage == "SUPERSEDED",
            "FIXTURE_PREDECESSOR_STILL_READY",
        )?;
        match service.rollback(&first) {
            Err(error)
                if error.code() == "DEPLOYMENT_CLAIM_SUPERSEDED_OR_UNCONFIRMED"
                    && error.finalization_code().is_none() => {}
            Err(error) => return Err(error),
            Ok(_) => return Err(DeploymentError::new("FIXTURE_OLD_ROLLBACK_ACCEPTED")),
        }
        require(
            service.status(&first)?.stage == "SUPERSEDED",
            "FIXTURE_PREDECESSOR_CHANGED",
        )?;
        self.persist(
            "superseded",
            &json!({"first":first,"second":second,"oldRollbackRefused":true}),
        )?;
        self.return_operation(service, &second, "second-")
    }
    fn unchanged(&self) -> Result<()> {
        require(
            fs::read(self.root.join("data/console/unknown-binary-extension"))?
                == [0, 255, 42, 0, 128],
            "FIXTURE_BINARY_CHANGED",
        )?;
        require(
            fs::read(self.root.join("data/console/unicode-marker"))?
                == "retained café \u{2603}\0\n".as_bytes(),
            "FIXTURE_UNICODE_CHANGED",
        )
    }
    fn candidate_is_isolated(&self) -> Result<()> {
        let current = self
            .engine
            .container(self.ids.last().expect("adopted candidate"))?;
        let env = current["Config"]["Env"]
            .as_array()
            .ok_or_else(|| DeploymentError::new("FIXTURE_ENV"))?;
        for (key, value) in [
            ("HOME", "/home/agent"),
            ("TMPDIR", "/home/agent/tmp"),
            ("REVERIE_SHARED_WORKSPACE_PATH", "/home/agent/workspace"),
            (
                "REVERIE_SHARED_ATTACHMENTS_PATH",
                "/home/agent/workspace/attachments",
            ),
            ("REVERIE_DATA", "/instances/default"),
            ("REVERIE_DATA_DIR", "/instances/default/console"),
            ("REVERIE_INSTALL_CLIS", "none"),
            ("REVERIE_KOKORO_ENABLED", "0"),
            (
                "REVERIE_WORKER_SOCKET",
                "/run/reverie-fixture-no-worker.sock",
            ),
        ] {
            require(
                env.contains(&json!(format!("{key}={value}"))),
                "FIXTURE_CANDIDATE_ESCAPES_ISOLATION",
            )?;
        }
        require(
            current["Config"]["User"] == "1000:100",
            "FIXTURE_CANDIDATE_USER_CHANGED",
        )
    }
    fn stop_owned(&self) -> Result<()> {
        let mut result = Ok(());
        for id in &self.ids {
            let stopped = self.stop_one(id);
            result = DeploymentError::finalized(result, stopped);
        }
        result
    }
    fn stop_one(&self, id: &str) -> Result<()> {
        let current = self.engine.container(id)?;
        require(current["Id"] == id, "FIXTURE_ID_CHANGED")?;
        let name = crate::model::string(&current, "Name")?;
        require(self.names.contains(name), "FIXTURE_NAME_CHANGED")?;
        if current["State"]["Running"] == true {
            self.engine.stop(id)?;
        }
        require(
            self.engine.container(id)?["State"]["Running"] == false,
            "FIXTURE_STOP_UNCONFIRMED",
        )
    }
}

fn driver_cpu_affinity() -> Result<String> {
    let bytes = crate::installation::read_bounded(Path::new("/proc/self/status"), 64 * 1024)?;
    let status = std::str::from_utf8(&bytes)
        .map_err(|_| DeploymentError::new("FIXTURE_CPU_AFFINITY_UNKNOWN"))?;
    affinity_from_status(status)
}
fn affinity_from_status(status: &str) -> Result<String> {
    let mut fields = status
        .lines()
        .filter_map(|line| line.strip_prefix("Cpus_allowed_list:"));
    let affinity = fields
        .next()
        .map(str::trim)
        .ok_or_else(|| DeploymentError::new("FIXTURE_CPU_AFFINITY_UNKNOWN"))?;
    require(
        !affinity.is_empty()
            && fields.next().is_none()
            && affinity
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b',' | b'-'))
            && affinity.split(',').all(valid_cpu_range),
        "FIXTURE_CPU_AFFINITY_UNKNOWN",
    )?;
    Ok(affinity.to_owned())
}
fn valid_cpu_range(range: &str) -> bool {
    match range.split_once('-') {
        Some((first, last)) => first
            .parse::<u32>()
            .ok()
            .zip(last.parse::<u32>().ok())
            .is_some_and(|(first, last)| first <= last),
        None => range.parse::<u32>().is_ok(),
    }
}

#[test]
fn fixture_cpu_affinity_preserves_the_kernel_list_without_host_specific_limits() {
    for cpus in ["0", "0-7", "2,4-6,9", "0-191", "256-511"] {
        let status = format!(
            "Name:\tfixture\nCpus_allowed:\tff\nCpus_allowed_list:\t{cpus}\nMems_allowed_list:\t0\n"
        );
        assert_eq!(affinity_from_status(&status).unwrap(), cpus);
    }
}

#[cfg(target_os = "linux")]
#[test]
fn fixture_cpu_affinity_reads_actual_proc_status_despite_zero_size() {
    let metadata = fs::metadata("/proc/self/status").unwrap();
    assert!(metadata.is_file());
    assert_eq!(metadata.len(), 0, "proc reports no declared content length");
    assert!(!driver_cpu_affinity().unwrap().is_empty());
}

#[test]
fn fixture_cpu_affinity_refuses_missing_duplicate_and_malformed_kernel_values() {
    for cpus in [
        "",
        " ",
        "-",
        ",",
        "0,",
        ",0",
        "0,,2",
        "-1",
        "3-1",
        "0-1-2",
        "0 -2",
        "1.0",
        "+2",
        "all",
        "0;1",
        "4294967296",
    ] {
        assert!(
            affinity_from_status(&format!("Cpus_allowed_list:\t{cpus}\n")).is_err(),
            "{cpus}"
        );
    }
    assert!(affinity_from_status("Cpus_allowed:\tff\n").is_err());
    assert!(affinity_from_status("Cpus_allowed_list:\t0-7\nCpus_allowed_list:\t0-7\n").is_err());
}
#[test]
#[ignore = "explicit actual Docker qualification with exact old/new image IDs and synthetic owned data"]
fn native_swap_and_return() {
    qualify_swap_and_return(false, false);
}

#[test]
#[ignore = "explicit actual Docker native-to-native update and mode-correct rollback with synthetic owned data"]
fn native_to_native_swap_and_return() {
    qualify_swap_and_return(true, false);
}

#[test]
#[ignore = "explicit actual Docker sequential native updates, original claim handover and checked return"]
fn native_repeated_updates_and_return() {
    qualify_swap_and_return(true, true);
}

fn qualify_swap_and_return(native_source: bool, repeated: bool) {
    let old = std::env::var("REVERIE_DEPLOYMENT_TEST_OLD_IMAGE")
        .expect("exact owned qualification old image");
    let new = std::env::var("REVERIE_DEPLOYMENT_TEST_NEW_IMAGE")
        .expect("exact owned qualification new image");
    crate::model::image_id(&old).unwrap();
    crate::model::image_id(&new).unwrap();
    let mut fixture = Fixture::capture().unwrap();
    let result = fixture.create_old(&old, native_source).and_then(|()| {
        if repeated {
            fixture.run_repeated(&new)
        } else {
            fixture.run(&new)
        }
    });
    let stopped = fixture.stop_owned();
    DeploymentError::finalized(result, stopped).unwrap();
}
