//! Actual accepted G request controls and private owned fixture.
use super::*;
use crate::{reservation_gate::tests::Tree, worker_validation::load_owner_config};
use reverie_core::worker_wire::WorkerFrameHeader;
use reverie_host::{
    engine_metadata::EngineBootstrap,
    installed_worker_engine::InstalledWorkerEngine,
    worker_reports::{AcceptedWorkerServiceConnection, WorkerServiceConnection},
    worker_runtime::WorkerRuntime,
};
use serde_json::{Value as Json, json};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    os::unix::{fs::PermissionsExt, net::UnixStream},
};
const CID: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
mod peer;
struct Fixture {
    broker: InstallingBroker,
    tree: Tree,
    private: Json,
    inventory: Json,
}
impl Fixture {
    fn new() -> Self {
        let tree = Tree::new();
        for directory in ["goal", "goal/nonces", "goal/authority"] {
            let path = tree.root.join(directory);
            fs::create_dir(&path).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let mut raw: Json = serde_json::from_slice(&tree.raw).unwrap();
        raw.as_object_mut().unwrap().remove("resourceReservations");
        raw["socket"] = json!(tree.root.join("control/broker.sock"));
        raw["companyFile"] = json!(tree.root.join("goal/company.json"));
        raw["goalPrivateConfig"] = json!(tree.root.join("goal/config.json"));
        let paths: serde_json::Map<_, _> = [
            ("config", "goal/config.json"),
            ("key", "goal/key"),
            ("canonical", "goal/company.json"),
            ("nonce", "goal/nonces/state.json"),
            ("authority", "goal/authority"),
        ]
        .into_iter()
        .map(|(name, path)| {
            (
                name.to_owned(),
                json!({"host":tree.root.join(path),"server":tree.root.join(path)}),
            )
        })
        .collect();
        let private = json!({"version":1,"mode":"owner-only","issuer":"fixed-test","epoch":"epoch-1","serverContainerId":CID,"paths":paths,
            "nonce":{"storeId":"11111111-2222-3333-4444-555555555555","capacity":16,"flockExecutable":"/nix/store/fixed/flock"},
            "server":{"brokerSocket":raw["socket"],"custodyClient":"/nix/store/fixed/worker"}});
        tree.write("goal/config.json", &serde_json::to_vec(&private).unwrap());
        tree.write("goal/key", b"private fixture bytes are never projected");
        tree.write("goal/company.json", br#"{"employees":[]}"#);
        tree.write("goal/nonces/state.json", b"{}");
        tree.write("goal/nonces/state.json.lock", b"");
        tree.write("worker.json", &serde_json::to_vec(&raw).unwrap());
        fs::remove_file(tree.root.join("state/resource-reservation-control.json")).unwrap();
        tree.write("ps.out", b"");
        let snapshot = load_owner_config(&tree.root.join("worker.json")).unwrap();
        let bootstrap = EngineBootstrap::from_service(
            crate::test_process::engine_program().as_os_str(),
            BTreeMap::new(),
            tree.root.clone(),
        )
        .unwrap();
        let runtime = WorkerRuntime::new(
            InstalledWorkerEngine::new(bootstrap),
            snapshot.envelope().base(),
        );
        let broker = InstallingBroker::new(snapshot, runtime).unwrap();
        let inventory = json!([{"Id":CID,"Name":format!("/{}",raw["serverContainer"].as_str().unwrap()),
            "State":{"Running":true,"Pid":std::process::id()},"Config":{"User":format!("{}:{}",raw["uid"],raw["gid"])},
            "HostConfig":{"Runtime":"runc","Privileged":false},"Mounts":[{"Type":"bind","Source":tree.root,"Destination":tree.root}]}]);
        let fixture = Self {
            broker,
            tree,
            private,
            inventory,
        };
        fixture
            .tree
            .write("goal-ids.out", format!("{CID}\n").as_bytes());
        fixture.tree.write(
            "goal-inventory.out",
            &serde_json::to_vec(&fixture.inventory).unwrap(),
        );
        fixture
            .tree
            .write("goal-inventory-control", b"fixed Goal inventory child only");
        fixture
    }
    fn accept(&self, server: UnixStream) -> WorkerServiceConnection {
        let current = self.broker.configuration().unwrap();
        let AcceptedWorkerServiceConnection::Service(connection) = self
            .broker
            .reports
            .register_worker_connection(server)
            .unwrap()
            .receive_service_for_worker(&self.broker.telemetry, current.configuration())
            .unwrap()
        else {
            panic!("actual G record");
        };
        connection
    }
    fn request(&self, request: &[u8]) -> (u8, Vec<u8>, GoalCustodyHandlerClosed) {
        let (mut client, server) = UnixStream::pair().unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        send(&mut client, request);
        let closed = self
            .broker
            .handle_goal_custody(self.accept(server))
            .unwrap();
        let (kind, bytes) = reply(&mut client);
        assert_eq!(client.read(&mut [0]).unwrap(), 0);
        (kind, bytes, closed)
    }
    fn close(&self) {
        self.broker.close_command_telemetry(end()).unwrap();
        self.broker.storage.runtime.close(end()).unwrap();
    }
}
fn end() -> Instant {
    Instant::now() + Duration::from_secs(3)
}
fn send(client: &mut UnixStream, bytes: &[u8]) {
    client
        .write_all(
            &WorkerFrameHeader::for_payload(b'G', bytes.len())
                .unwrap()
                .encode(),
        )
        .unwrap();
    client.write_all(bytes).unwrap();
}
fn reply(client: &mut UnixStream) -> (u8, Vec<u8>) {
    let mut header = [0; 5];
    client.read_exact(&mut header).unwrap();
    let length = u32::from_be_bytes(header[1..].try_into().unwrap()) as usize;
    assert!(length <= 32768);
    let mut body = vec![0; length];
    client.read_exact(&mut body).unwrap();
    (header[0], body)
}
#[test]
fn actual_g_projects_all_private_identities_and_ignores_nonutf8_stderr_on_same_capture() {
    crate::test_process::owning_case!(
        actual_g_projects_all_private_identities_and_ignores_nonutf8_stderr_on_same_capture
    );
    use sha2::{Digest, Sha256};
    let fixture = Fixture::new();
    fixture
        .tree
        .write("goal-ignored.stderr", &vec![0xff; 1024 * 1024 + 1]);
    let (kind, bytes, closed) = fixture.request(br#"{"action":"goal-custody"}"#);
    assert_eq!(kind, b'J', "{}", String::from_utf8_lossy(&bytes));
    assert!(closed.primary_error_code().is_none());
    let value: Json = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value["version"], 1);
    assert_eq!(
        value["configDigest"],
        format!(
            "{:x}",
            Sha256::digest(fs::read(fixture.tree.root.join("goal/config.json")).unwrap())
        )
    );
    assert_eq!(value["identities"].as_object().unwrap().len(), 14);
    assert!(
        value["identities"]["canonicalLock"].is_null()
            && value["identities"]["noncePending"].is_null()
    );
    assert_eq!(
        value["identities"]["key"][2],
        fs::metadata(fixture.tree.root.join("goal/key"))
            .unwrap()
            .len()
            .to_string()
    );
    assert!(
        !String::from_utf8(bytes)
            .unwrap()
            .contains("private fixture bytes")
    );
    fixture.close();
}
#[test]
fn actual_g_rejects_request_paths_before_engine_and_schema_failure_latches_config_identity() {
    crate::test_process::owning_case!(
        actual_g_rejects_request_paths_before_engine_and_schema_failure_latches_config_identity
    );
    let fixture = Fixture::new();
    let (kind, _, closed) = fixture.request(br#"{"action":"goal-custody","path":"/private/key"}"#);
    assert_eq!(kind, b'E');
    assert!(closed.primary_error_code().is_some());
    assert!(!fixture.tree.root.join("calls.txt").exists());
    let mut bad = fixture.private.clone();
    bad["version"] = json!(true);
    fixture
        .tree
        .write("goal/config.json", &serde_json::to_vec(&bad).unwrap());
    assert_eq!(fixture.request(br#"{"action":"goal-custody"}"#).0, b'E');
    fixture.tree.write(
        "goal/config.json",
        &serde_json::to_vec(&fixture.private).unwrap(),
    );
    let (kind, _, closed) = fixture.request(br#"{"action":"goal-custody"}"#);
    assert_eq!(kind, b'E');
    assert_eq!(
        closed.primary_error_code(),
        Some("Private Goal configuration changed; restart required")
    );
    assert!(!fixture.tree.root.join("calls.txt").exists());
    fixture.close();
}
#[test]
fn actual_g_refuses_employee_mode_and_runtime_injection_before_missing_key_read() {
    crate::test_process::owning_case!(
        actual_g_refuses_employee_mode_and_runtime_injection_before_missing_key_read
    );
    let fixture = Fixture::new();
    let mut inventory = fixture.inventory.clone();
    inventory[0]["HostConfig"]["Privileged"] = json!(true);
    fixture.tree.write(
        "goal-inventory.out",
        &serde_json::to_vec(&inventory).unwrap(),
    );
    fs::remove_file(fixture.tree.root.join("goal/key")).unwrap();
    let (kind, _, closed) = fixture.request(br#"{"action":"goal-custody"}"#);
    assert_eq!(kind, b'E');
    assert_eq!(
        closed.primary_error_code(),
        Some("Private Goal configuration unavailable")
    );
    fixture.close();
    let fixture = Fixture::new();
    let mut config = fixture.private.clone();
    config["mode"] = json!("owner-and-employee");
    fixture
        .tree
        .write("goal/config.json", &serde_json::to_vec(&config).unwrap());
    assert_eq!(fixture.request(br#"{"action":"goal-custody"}"#).0, b'E');
    assert!(!fixture.tree.root.join("calls.txt").exists());
    fixture.close();
}
#[test]
fn actual_g_refuses_private_mount_alias_before_key_and_fresh_worker_policy_change() {
    crate::test_process::owning_case!(
        actual_g_refuses_private_mount_alias_before_key_and_fresh_worker_policy_change
    );
    let fixture = Fixture::new();
    let mut inventory = fixture.inventory.clone();
    inventory.as_array_mut().unwrap().push(json!({"Id":"b".repeat(64),"Config":{},"HostConfig":{"Runtime":"runc","Privileged":false},"Mounts":[{"Type":"bind","Source":fixture.tree.root.join("goal")}]}));
    fixture.tree.write(
        "goal-inventory.out",
        &serde_json::to_vec(&inventory).unwrap(),
    );
    fixture.tree.write(
        "goal-ids.out",
        format!("{CID}\n{}\n", "b".repeat(64)).as_bytes(),
    );
    fs::remove_file(fixture.tree.root.join("goal/key")).unwrap();
    let (kind, _, closed) = fixture.request(br#"{"action":"goal-custody"}"#);
    assert_eq!(kind, b'E');
    assert_eq!(
        closed.primary_error_code(),
        Some("Private Goal scope exposed to a worker")
    );
    fixture.close();
    let fixture = Fixture::new();
    let mut raw: Json =
        serde_json::from_slice(&fs::read(fixture.tree.root.join("worker.json")).unwrap()).unwrap();
    raw["memoryMiB"] = json!(2048);
    fixture
        .tree
        .write("worker.json", &serde_json::to_vec(&raw).unwrap());
    let (kind, _, closed) = fixture.request(br#"{"action":"goal-custody"}"#);
    assert_eq!(kind, b'E');
    assert_eq!(
        closed.primary_error_code(),
        Some("Worker policy changed; Goal bootstrap unavailable")
    );
    assert!(!fixture.tree.root.join("calls.txt").exists());
    fixture.close();
}
#[test]
fn actual_failed_goal_read_closes_known_resources_then_same_service_accepts_next_g() {
    crate::test_process::owning_case!(
        actual_failed_goal_read_closes_known_resources_then_same_service_accepts_next_g
    );
    let fixture = Fixture::new();
    fixture.tree.write(
        "goal-stall-read",
        b"fixed owned read child waits beyond original 500ms query",
    );
    let (kind, _, closed) = fixture.request(br#"{"action":"goal-custody"}"#);
    assert_eq!(kind, b'E');
    assert!(closed.primary_error_code().is_some());
    fs::remove_file(fixture.tree.root.join("goal-stall-read")).unwrap();
    let (kind, bytes, closed) = fixture.request(br#"{"action":"goal-custody"}"#);
    assert_eq!(kind, b'J', "{}", String::from_utf8_lossy(&bytes));
    assert!(closed.primary_error_code().is_none());
    fixture.close();
}
