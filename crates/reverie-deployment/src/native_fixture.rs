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
    fn create_old(&mut self, image: &str) -> Result<()> {
        let previous = self.engine.image(image)?;
        require(previous["Id"] == image, "FIXTURE_IMAGE_CHANGED")?;
        let body = self.body(&previous)?;
        let created = self.engine.json(
            "POST",
            &format!("/containers/create?name={}", self.name),
            Some(&body),
        )?;
        let id = crate::model::cid(crate::model::string(&created, "Id")?)?.to_owned();
        self.ids.push(id.clone());
        self.persist("old-created", &json!({"id":id}))?;
        self.engine.start(&id)
    }
    fn body(&self, image: &Value) -> Result<Value> {
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
        for key in [
            "REVERIE_NATIVE_FRONT",
            "REVERIE_FRONT_CHILD",
            "REVERIE_NATIVE_FRONT_BIN",
        ] {
            require(!env.contains_key(key), "FIXTURE_OLD_SELECTS_FRONT")?;
        }
        let mounts = [("data","/instances/default"),("home","/home/agent")].into_iter().map(|(source,target)|json!({
            "Type":"bind","Source":self.root.join(source),"Target":target,"ReadOnly":false,"BindOptions":{"CreateMountpoint":false}
        })).collect::<Vec<_>>();
        Ok(
            json!({"Image":image["Id"],"User":"1000:100","Env":env.into_values().collect::<Vec<_>>(),
            "Entrypoint":image["Config"]["Entrypoint"],"Cmd":image["Config"]["Cmd"],
            "ExposedPorts":{"3000/tcp":{}},"HostConfig":{"Mounts":mounts,"NetworkMode":"bridge","AutoRemove":false,
                "Init":true,"Memory":536870912u64,"MemorySwap":536870912u64,"PidsLimit":256,
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
        let old = self.ids[0].clone();
        service.await_ready(&old, false)?;
        let preview = service.preview(candidate)?;
        let prefix = self.name.chars().take(24).collect::<String>();
        for phase in ["candidate", "before-front", "failed-front"] {
            self.names
                .insert(format!("/{prefix}-{phase}-{}", &preview.operation[..16]));
        }
        self.persist("preview", &serde_json::to_value(&preview)?)?;
        let prepared = service.prepare(&preview.operation)?;
        let id = prepared
            .candidate_id
            .clone()
            .ok_or_else(|| DeploymentError::new("FIXTURE_CANDIDATE_MISSING"))?;
        self.ids.push(id);
        self.candidate_is_isolated()?;
        self.persist("prepared", &serde_json::to_value(&prepared)?)?;
        require(prepared.stage == "PREPARED", "FIXTURE_PREPARE_UNCONFIRMED")?;
        let applied = service.apply(&preview.operation)?;
        self.persist("applied", &serde_json::to_value(&applied)?)?;
        require(applied.stage == "HYBRID_READY", "FIXTURE_APPLY_UNCONFIRMED")?;
        self.unchanged()?;
        let returned = service.rollback(&preview.operation)?;
        self.persist("returned", &serde_json::to_value(&returned)?)?;
        require(returned.stage == "RESTORED", "FIXTURE_RETURN_UNCONFIRMED")?;
        self.unchanged()
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
#[test]
#[ignore = "explicit actual Docker qualification with exact old/new image IDs and synthetic owned data"]
fn native_swap_and_return() {
    let old = std::env::var("REVERIE_DEPLOYMENT_TEST_OLD_IMAGE")
        .expect("exact owned qualification old image");
    let new = std::env::var("REVERIE_DEPLOYMENT_TEST_NEW_IMAGE")
        .expect("exact owned qualification new image");
    crate::model::image_id(&old).unwrap();
    crate::model::image_id(&new).unwrap();
    let mut fixture = Fixture::capture().unwrap();
    let result = fixture.create_old(&old).and_then(|()| fixture.run(&new));
    let stopped = fixture.stop_owned();
    DeploymentError::finalized(result, stopped).unwrap();
}
