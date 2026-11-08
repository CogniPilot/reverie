//! Actual accepted records and kernel peer handles. These are negative entry
//! controls, never synthetic successful website or current-owner capabilities.
use super::*;
use crate::{reservation_gate::tests::Tree, worker_validation::load_owner_config};
use reverie_core::worker_wire::WorkerFrameHeader;
use reverie_host::{
    engine_metadata::EngineBootstrap, installed_worker_engine::InstalledWorkerEngine,
    worker_reports::AcceptedWorkerServiceConnection, worker_runtime::WorkerRuntime,
};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    os::unix::net::UnixStream,
};
struct Fixture {
    broker: InstallingBroker,
    tree: Tree,
}
impl Fixture {
    fn new() -> Self {
        let tree = Tree::new();
        let mut raw: serde_json::Value = serde_json::from_slice(&tree.raw).unwrap();
        raw.as_object_mut().unwrap().remove("resourceReservations");
        raw.as_object_mut().unwrap().remove("resourceActorConfig");
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
        Self {
            broker: InstallingBroker::new(snapshot, runtime).unwrap(),
            tree,
        }
    }
    fn accept(&self, purpose: u8, raw: &[u8]) -> (UnixStream, WorkerServiceConnection) {
        let (mut client, server) = UnixStream::pair().unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        client
            .write_all(
                &WorkerFrameHeader::for_payload(purpose, raw.len())
                    .unwrap()
                    .encode(),
            )
            .unwrap();
        client.write_all(raw).unwrap();
        let AcceptedWorkerServiceConnection::Service(connection) = self
            .broker
            .reports
            .register_worker_connection(server)
            .unwrap()
            .receive_service_for_worker(
                &self.broker.telemetry,
                self.broker.configuration().unwrap().configuration(),
            )
            .unwrap()
        else {
            panic!("actual fixed-purpose record")
        };
        (client, connection)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.broker.reports.close(end()).unwrap();
        self.broker.storage.runtime.close(end()).unwrap();
    }
}
fn end() -> Instant {
    Instant::now() + Duration::from_secs(3)
}
fn close(failure: &mut ResourceActorFailure<'_>, client: &mut UnixStream) {
    failure.close_channel_component(end()).unwrap();
    assert_eq!(
        client.read(&mut [0]).unwrap(),
        0,
        "no greeting before qualification"
    );
}
#[test]
fn actual_ram_q_refuses_old_hello_then_missing_gate_before_native_or_owner_authority() {
    crate::test_process::owning_case!(
        actual_ram_q_refuses_old_hello_then_missing_gate_before_native_or_owner_authority
    );
    let fixture = Fixture::new();
    for (raw, code) in [
        (
            br#"{"purpose":"resource-replacement-v1","version":1}"#.as_slice(),
            "RESOURCE_RAM_BINDING_CHANGED",
        ),
        (
            br#"{"purpose":"resource-ram-pool-v2","version":2}"#.as_slice(),
            "RESOURCE_ACTOR_GATE_REQUIRED",
        ),
    ] {
        let (mut client, connection) = fixture.accept(b'Q', raw);
        let mut failure = fixture
            .broker
            .prepare_resource_website(connection)
            .err()
            .unwrap();
        assert_eq!(failure.cause().code(), code);
        close(&mut failure, &mut client);
    }
    assert!(
        !fixture.tree.root.join("calls.txt").exists(),
        "entry refusals must not query engine"
    );
}
#[test]
fn actual_ram_q_refuses_foreign_runtime_and_other_purpose_without_adopting_their_record() {
    crate::test_process::owning_case!(
        actual_ram_q_refuses_foreign_runtime_and_other_purpose_without_adopting_their_record
    );
    let first = Fixture::new();
    let other = Fixture::new();
    let hello = br#"{"purpose":"resource-ram-pool-v2","version":2}"#;
    let (mut client, connection) = other.accept(b'Q', hello);
    let mut failure = first
        .broker
        .prepare_resource_website(connection)
        .err()
        .unwrap();
    assert_eq!(failure.cause().code(), "RESOURCE_ACTOR_CHANNEL_ORIGIN");
    close(&mut failure, &mut client);
    let (mut client, connection) = first.accept(b'C', hello);
    let mut failure = first
        .broker
        .prepare_resource_website(connection)
        .err()
        .unwrap();
    assert_eq!(failure.cause().code(), "RESOURCE_ACTOR_CHANNEL_ORIGIN");
    close(&mut failure, &mut client);
}
