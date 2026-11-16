//! Controlled Engine-port facts only. This never targets Docker or claims
//! kernel/container readiness. The real service and root-peer transport run.
use super::*;
use crate::{engine::Engine, installation, networks::Topology};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    os::unix::{
        fs::{DirBuilderExt, PermissionsExt, symlink},
        net::{UnixListener, UnixStream},
    },
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
};
mod health;

type Facts = Arc<Mutex<BTreeMap<String, Value>>>;
pub(super) struct Port {
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
    pub(super) fn set(&self, path: String, value: Value) {
        self.facts.lock().unwrap().insert(path, value);
    }
    pub(super) fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
    pub(super) fn clear(&self) {
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
    let value = (method == "GET")
        .then(|| facts.lock().unwrap().get(path).cloned())
        .flatten();
    let status = if value.is_some() {
        "200 OK"
    } else {
        "500 Refused"
    };
    let body =
        serde_json::to_vec(&value.unwrap_or_else(|| json!({"message":"controlled refusal"})))
            .unwrap();
    write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Length:{}\r\nConnection:close\r\n\r\n",
        body.len()
    )
    .unwrap();
    stream.write_all(&body).unwrap();
}

pub(super) struct Fixture {
    pub(super) service: DeploymentService,
    pub(super) operation: Operation,
    pub(super) source: Value,
    pub(super) port: Port,
    health: health::Health,
}
impl Fixture {
    pub(super) fn new() -> Self {
        let port = Port::start();
        let health = health::Health::start();
        let root = Path::new("/tmp/deployment");
        fs::DirBuilder::new().mode(0o700).create(root).unwrap();
        fs::create_dir(root.join("data")).unwrap();
        let config = json!({"version":1,"containerName":"fixture","port":health.port(),"websiteRuntime":"default"});
        installation::exclusive_json(&root.join("deployment.json"), &config).unwrap();
        let service = DeploymentService::capture(root).unwrap();
        let source = source(health.port());
        for (name, id) in [("bridge", "1".repeat(64)), ("api", "2".repeat(64))] {
            port.set(
                format!("/networks/{id}"),
                json!({"Id":id,"Name":name,"Driver":"bridge",
                "Scope":"local","Ingress":false,"ConfigOnly":false,"Containers":{}}),
            );
        }
        let engine = Engine::new(Path::new("/var/run/docker.sock")).unwrap();
        let topology = Topology::capture(&source, &engine).unwrap();
        let operation = operation(&service, &source, topology);
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
        port.clear();
        Self {
            service,
            operation,
            source,
            port,
            health,
        }
    }
    pub(super) fn drifted(&self) -> Value {
        let mut value = self.source.clone();
        value["NetworkSettings"]["Networks"]["api"]["Aliases"] = json!(["foreign"]);
        value
    }
    pub(super) fn close(mut self) {
        self.service.close().unwrap();
        assert_eq!(
            self.health.requests(),
            0,
            "Unexpected fixture health request"
        );
    }
}
fn image(letter: char) -> Value {
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
fn operation(service: &DeploymentService, source: &Value, topology: Topology) -> Operation {
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
    };
    let operation = Operation::create(
        &service.installation.state,
        Plan {
            version: 4,
            operation: preview.operation.clone(),
            container: "fixture".into(),
            installation_revision: service.installation.revision.clone(),
            source: source.clone(),
            body,
            preview,
            bind_identities: identities,
            network_topology: Some(topology),
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
    value
}
