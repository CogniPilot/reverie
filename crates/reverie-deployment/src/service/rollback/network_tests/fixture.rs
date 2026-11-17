//! Controlled Engine-port facts only. This never targets Docker or claims
//! kernel/container readiness. The real service and root-peer transport run.
use super::*;
use crate::{engine::Engine, installation, networks::Topology};
use std::{
    collections::{BTreeMap, VecDeque},
    io::{Read, Write},
    os::unix::{
        fs::{PermissionsExt, symlink},
        net::{UnixListener, UnixStream},
    },
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
};
mod health;

type Facts = Arc<Mutex<BTreeMap<String, VecDeque<(u16, Value)>>>>;
pub(in crate::service) struct Port {
    facts: Facts,
    calls: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}
impl Port {
    fn start() -> Self {
        symlink("/run", "/var/run").unwrap();
        let listener = UnixListener::bind("/run/docker.sock").unwrap();
        fs::set_permissions("/run/docker.sock", fs::Permissions::from_mode(0o660)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let facts = Facts::default();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let inputs = (facts.clone(), calls.clone(), stop.clone());
        let thread = thread::spawn(move || serve(listener, inputs));
        Self {
            facts,
            calls,
            stop,
            thread: Some(thread),
        }
    }
    pub(in crate::service) fn set(&self, path: String, value: Value) {
        self.set_sequence(path, vec![value]);
    }
    pub(in crate::service) fn set_sequence(&self, path: String, values: Vec<Value>) {
        assert!(!values.is_empty());
        self.facts
            .lock()
            .unwrap()
            .insert(path, values.into_iter().map(|value| (200, value)).collect());
    }
    pub(in crate::service) fn absent(&self, id: &str) {
        self.facts.lock().unwrap().insert(
            format!("/containers/{id}/json"),
            vec![(404, json!({"message":"controlled absent CID"}))].into(),
        );
    }
    pub(in crate::service) fn replies(&self, id: &str, values: Vec<(u16, Value)>) {
        self.facts
            .lock()
            .unwrap()
            .insert(format!("/containers/{id}/json"), values.into());
    }
    pub(in crate::service) fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
    pub(in crate::service) fn clear(&self) {
        self.calls.lock().unwrap().clear();
    }
}
impl Drop for Port {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        self.thread.take().unwrap().join().unwrap();
    }
}
fn serve(listener: UnixListener, inputs: (Facts, Arc<Mutex<Vec<String>>>, Arc<AtomicBool>)) {
    let (facts, calls, stop) = inputs;
    while !stop.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((stream, _)) => respond(stream, &facts, &calls),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(1))
            }
            Err(error) => panic!("controlled Engine accept: {error}"),
        }
    }
}
fn respond(mut stream: UnixStream, facts: &Facts, calls: &Mutex<Vec<String>>) {
    stream
        .set_read_timeout(Some(Duration::from_secs(1)))
        .unwrap();
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") && head.len() < 8192 {
        let mut byte = [0];
        if stream.read_exact(&mut byte).is_err() {
            break;
        }
        head.push(byte[0]);
    }
    let text = String::from_utf8(head).unwrap();
    let mut words = text.split_whitespace();
    let method = words.next().unwrap_or("missing");
    let path = words.next().unwrap_or("missing");
    calls.lock().unwrap().push(format!("{method} {path}"));
    let value = response(facts, method, path);
    let (status, value) = value.unwrap_or_else(|| (500, json!({"message":"controlled refusal"})));
    let body = serde_json::to_vec(&value).unwrap();
    write!(
        stream,
        "HTTP/1.1 {status} Fixture\r\nContent-Length:{}\r\nConnection:close\r\n\r\n",
        body.len()
    )
    .unwrap();
    stream.write_all(&body).unwrap();
}
fn response(facts: &Facts, method: &str, path: &str) -> Option<(u16, Value)> {
    let mut facts = facts.lock().unwrap();
    let key = format!("{method} {path}");
    let key = if facts.contains_key(&key) {
        key.as_str()
    } else if method == "GET" {
        path
    } else {
        return None;
    };
    let values = facts.get_mut(key)?;
    if values.len() > 1 {
        values.pop_front()
    } else {
        values.front().cloned()
    }
}

pub(in crate::service) struct Fixture {
    pub(in crate::service) service: DeploymentService,
    pub(in crate::service) operation: Operation,
    pub(in crate::service) source: Value,
    pub(in crate::service) port: Port,
    health: health::Health,
}
impl Fixture {
    pub(in crate::service) fn new() -> Self {
        Self::selected(false, false)
    }
    pub(in crate::service) fn live_accounts() -> Self {
        Self::selected(true, false)
    }
    pub(in crate::service) fn adopting() -> Self {
        Self::selected(false, true)
    }
    pub(in crate::service) fn missing_candidate() -> Self {
        Self::missing(Self::new())
    }
    pub(in crate::service) fn missing_live_accounts() -> Self {
        Self::missing(Self::live_accounts())
    }
    fn missing(mut fixture: Self) -> Self {
        fixture.source["State"]["Running"] = json!(true);
        fixture.source["State"]["Status"] = json!("running");
        fixture.source["State"]["Pid"] = json!(std::process::id());
        fixture.operation.plan.source = fixture.source.clone();
        fs::write(
            fixture.operation.directory.join("plan.json"),
            serde_json::to_vec(&fixture.operation.plan).unwrap(),
        )
        .unwrap();
        fixture.port.set(
            format!("/containers/{}/json", "a".repeat(64)),
            fixture.source.clone(),
        );
        fixture
            .port
            .set("/containers/fixture/json".into(), fixture.source.clone());
        fixture.port.set(
            format!(
                "/containers/{}/top?ps_args=-eo%20pid,ppid,comm",
                "a".repeat(64)
            ),
            json!({"Processes":[["1","0","reverie-front"],["2","1","node"]]}),
        );
        fixture.port.absent(&"b".repeat(64));
        fixture.health.healthy();
        fixture.port.clear();
        fixture
    }
    fn selected(live_accounts: bool, adopting: bool) -> Self {
        let port = Port::start();
        let health = health::Health::start();
        let root = Path::new("/tmp/deployment");
        fs::create_dir_all(root.join("data")).unwrap();
        fs::set_permissions(root, fs::Permissions::from_mode(0o700)).unwrap();
        let config = json!({"version":1,"containerName":"fixture","port":health.port(),"websiteRuntime":"default"});
        installation::exclusive_json(&root.join("deployment.json"), &config).unwrap();
        let service = DeploymentService::capture(root).unwrap();
        let mut source = source(health.port());
        if adopting {
            source["State"]["Running"] = json!(true);
            source["State"]["Status"] = json!("running");
            source["State"]["Pid"] = json!(std::process::id());
            source["Mounts"] = json!(["/instances/default","/home/agent","/reverie_workspace"].map(|target|json!({"Type":"bind","Source":"/tmp/deployment/data","Destination":target,"RW":true,"Propagation":"rprivate"})));
            source["HostConfig"]["Binds"] = json!([
                "/tmp/deployment/data:/instances/default:rw",
                "/tmp/deployment/data:/home/agent:rw",
                "/tmp/deployment/data:/reverie_workspace:rw"
            ]);
            fs::create_dir_all(root.join("data/console")).unwrap();
        }
        if live_accounts {
            fs::create_dir_all(root.join("data/console/accounts/profile")).unwrap();
            fs::remove_file(root.join("data/disjoint-source")).unwrap();
            fs::create_dir(root.join("data/disjoint-source")).unwrap();
            source["Mounts"][0]["Destination"] = json!("/instances/default");
            source["Mounts"][0]["RW"] = json!(true);
            source["HostConfig"]["Binds"] = json!(["/tmp/deployment/data:/instances/default:rw"]);
            source["State"]["Running"] = json!(true);
            source["State"]["Status"] = json!("running");
            source["State"]["Pid"] = json!(std::process::id());
            let worker = worker();
            port.set(
                format!("/containers/{}/json", "d".repeat(64)),
                worker.clone(),
            );
            port.set("/containers/json".into(), json!([
                {"Id":"a".repeat(64),"State":"running","ImageID":source["Image"],"Mounts":source["Mounts"]},
                {"Id":"d".repeat(64),"State":"running","ImageID":worker["Image"],"Mounts":worker["Mounts"]}
            ]));
        }
        for (name, id) in [("bridge", "1".repeat(64)), ("api", "2".repeat(64))] {
            port.set(
                format!("/networks/{id}"),
                json!({"Id":id,"Name":name,"Driver":"bridge",
                "Scope":"local","Ingress":false,"ConfigOnly":false,"Containers":{}}),
            );
        }
        let engine = Engine::new(Path::new("/var/run/docker.sock")).unwrap();
        let topology = Topology::capture(&source, &engine).unwrap();
        let writers = live_accounts.then(|| {
            crate::live_accounts::Inventory::capture(
                &engine,
                &root.join("data/console"),
                &[&"a".repeat(64)],
            )
            .unwrap()
        });
        let operation = operation(&service, &source, topology, writers);
        installation::exclusive_json(
            &service
                .installation
                .state
                .join("console-deployment-active.json"),
            &json!({"operation":operation.plan.operation}),
        )
        .unwrap();
        port.set(
            format!("/containers/{}/json", "a".repeat(64)),
            source.clone(),
        );
        port.set(
            format!("/containers/{}/json", "b".repeat(64)),
            candidate(&operation),
        );
        if adopting {
            configure_adoption(&port, &health, &operation, &mut source);
        }
        port.clear();
        Self {
            service,
            operation,
            source,
            port,
            health,
        }
    }
    pub(in crate::service) fn drifted(&self) -> Value {
        let mut value = self.source.clone();
        value["NetworkSettings"]["Networks"]["api"]["Aliases"] = json!(["foreign"]);
        value
    }
    pub(in crate::service) fn close(mut self) {
        self.service.close().unwrap();
        assert_eq!(
            self.health.requests(),
            0,
            "Unexpected fixture health request"
        );
    }
    pub(in crate::service) fn close_adoption(mut self) {
        self.service.close().unwrap();
        assert!(self.health.requests() > 0);
    }
    pub(in crate::service) fn refuse_health(&self) {
        self.health.refuse();
    }
}
fn configure_adoption(
    port: &Port,
    health: &health::Health,
    operation: &Operation,
    source: &mut Value,
) {
    operation
        .record(
            "ready",
            &json!({"containerId":"b".repeat(64),"mode":"hybrid-rust-front","brokerChanged":false}),
        )
        .unwrap();
    source["Id"] = json!("e".repeat(64));
    port.absent(&"a".repeat(64));
    port.absent(&"b".repeat(64));
    port.set("/containers/fixture/json".into(), source.clone());
    port.set(
        format!("/containers/{}/json", "e".repeat(64)),
        source.clone(),
    );
    port.set(
        "/containers/json".into(),
        json!([{"Id":source["Id"],"State":"running","Mounts":source["Mounts"]}]),
    );
    for name in ['e', 'f'] {
        port.set(
            format!("/images/{}/json", image(name)["Id"].as_str().unwrap()),
            image(name),
        );
    }
    port.set(
        format!(
            "/containers/{}/top?ps_args=-eo%20pid,ppid,comm",
            "e".repeat(64)
        ),
        json!({"Processes":[["1","0","reverie-front"],["2","1","node"]]}),
    );
    health.healthy();
}
pub(in crate::service) fn image(letter: char) -> Value {
    json!({"Id":format!("sha256:{}", letter.to_string().repeat(64)), "Config":{
        "Env":["REVERIE_NATIVE_FRONT=1"],"Entrypoint":["entry"],"Cmd":["web"],"Volumes":null}})
}
fn source(port: u16) -> Value {
    let mut config = image('e')["Config"].clone();
    config["Image"] = image('e')["Id"].clone();
    json!({"Id":"a".repeat(64),"Name":"/fixture","Image":image('e')["Id"],"Config":config,
        "State":{"Running":false,"Status":"exited","Paused":false,"Restarting":false,"Dead":false,"Pid":0,"StartedAt":"epoch"},
        "HostConfig":{"Binds":["/tmp/deployment/data:/tmp/deployment/data:ro"],"AutoRemove":false,
            "Privileged":false,"NetworkMode":"bridge","PortBindings":{"3000/tcp":[{"HostIp":"127.0.0.1","HostPort":port.to_string()}]}},
        "Mounts":[{"Type":"bind","Source":"/tmp/deployment/data","Destination":"/tmp/deployment/data","RW":false,"Propagation":"rprivate"}],
        "NetworkSettings":{"Networks":{"bridge":{"NetworkID":"1".repeat(64),"Aliases":null},
            "api":{"NetworkID":"2".repeat(64),"Aliases":["reverie"]}}}})
}
fn operation(
    service: &DeploymentService,
    source: &Value,
    topology: Topology,
    writers: Option<crate::live_accounts::Inventory>,
) -> Operation {
    let (body, refreshed) = model::create_body_selection(
        source,
        &image('e'),
        &image('f'),
        model::DeploymentProfile::Ordinary,
        Some(&topology),
    )
    .unwrap();
    let pins = crate::pins::Pins::capture(source).unwrap();
    let identities = pins.identities();
    pins.close().unwrap();
    let preview = DeploymentPreview {
        claim_adoption: None,
        operation: "c".repeat(32),
        container: "fixture".into(),
        source_id: "a".repeat(64),
        source_image: image('e')["Id"].as_str().unwrap().into(),
        candidate_image: image('f')["Id"].as_str().unwrap().into(),
        environment_policy: "controlled fixture".into(),
        refreshed_environment_keys: refreshed,
        broker_preserved: true,
        backup_metadata_scope: "controlled fixture".into(),
        profile: None,
        preserved_networks: Some(topology.preview()),
        live_accounts: writers
            .as_ref()
            .map(crate::live_accounts::Inventory::preview),
    };
    let operation = Operation::create(
        &service.installation.state,
        Plan {
            claim_adoption: None,
            version: if writers.is_some() { 5 } else { 4 },
            operation: preview.operation.clone(),
            container: "fixture".into(),
            installation_revision: service.installation.revision.clone(),
            source: source.clone(),
            body,
            preview,
            bind_identities: identities,
            network_topology: Some(topology),
            live_account_writers: writers,
        },
    )
    .unwrap();
    operation
        .record("candidate", &json!({"id":"b".repeat(64)}))
        .unwrap();
    operation
        .record(
            "prepared",
            &json!({"candidateId":"b".repeat(64),"validated":true}),
        )
        .unwrap();
    operation
}
fn candidate(operation: &Operation) -> Value {
    let mut config = operation.plan.body.clone();
    config.as_object_mut().unwrap().remove("HostConfig");
    config.as_object_mut().unwrap().remove("NetworkingConfig");
    let mut value = operation.plan.source.clone();
    value["Id"] = json!("b".repeat(64));
    value["Image"] = image('f')["Id"].clone();
    value["Config"] = config;
    value["HostConfig"] = operation.plan.body["HostConfig"].clone();
    value["Name"] = json!(format!(
        "/{}",
        super::super::temporary_name(operation, "candidate")
    ));
    value["State"]["Status"] = json!("created");
    value["State"]["Running"] = json!(false);
    value["State"]["Pid"] = json!(0);
    value
}

pub(in crate::service) fn worker() -> Value {
    json!({"Id":"d".repeat(64),"Image":image('e')["Id"],"Config":{"Cmd":["existing-provider"],"Env":["FAKE_PRIVATE=not-public"]},"HostConfig":{},
        "Mounts":[{"Type":"bind","Source":"/tmp/deployment/data/console/accounts/profile","Destination":"/accounts/profile","RW":true}],
        "State":{"Running":true,"Paused":false,"Restarting":false,"Dead":false,"Pid":std::process::id(),"StartedAt":"original"}})
}
