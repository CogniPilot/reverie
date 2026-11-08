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
    retained: bool,
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
            retained: false,
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
        let reports = self.broker.reports.close(end());
        let runtime = self.broker.storage.runtime.close(end());
        runtime.unwrap();
        if self.retained {
            assert!(
                reports.is_err(),
                "original unknown owner must remain counted"
            );
        } else {
            reports.unwrap();
        }
    }
}
#[test]
fn actual_q_record_retains_stateless_close_error_after_disconnect_and_repeated_close() {
    crate::test_process::owning_case!(
        actual_q_record_retains_stateless_close_error_after_disconnect_and_repeated_close
    );
    let mut fixture = Fixture::new();
    // Negative latch composition only: actual native close production is
    // separately measured by Host and Store controls, not fabricated here.
    let cause = reverie_host::ObservationError::CloseUnconfirmed {
        cause: std::io::Error::other("typed consumed-close witness"),
    };
    let kernel = reverie_host::reservation_kernel::ReservationKernelError::from(cause);
    let observed = crate::reservation_observer::ObserverError::from(kernel);
    fixture.retained = true;
    for cause in [observed.into(), company_close_error()] {
        let (mut client, connection) = fixture.accept(b'Q', b"{}");
        let mut failure = fixture
            .broker
            .prepare_resource_website(connection)
            .err()
            .unwrap();
        let body = failure.frame.retain_stateless_result::<()>(Err(cause));
        let first = failure.close_channel_component(end());
        let eof = client.read(&mut [0]);
        let repeated = failure.close_channel_component(end());
        let retained = failure.frame.unconfirmed.clone();
        assert!(body.unwrap_err().has_unconfirmed_close());
        assert!(first.unwrap_err().has_unconfirmed_close());
        assert_eq!(eof.unwrap(), 0, "same original socket must still close");
        assert!(repeated.unwrap_err().has_unconfirmed_close());
        assert_same_close(
            retained.as_ref().unwrap(),
            failure.frame.unconfirmed.as_ref().unwrap(),
        );
    }
}
fn assert_same_close(first: &custody::RetainedClose, second: &custody::RetainedClose) {
    use custody::RetainedClose;
    match (first, second) {
        (RetainedClose::Company(a), RetainedClose::Company(b)) => assert!(Arc::ptr_eq(a, b)),
        (RetainedClose::Kernel(a), RetainedClose::Kernel(b)) => assert!(Arc::ptr_eq(a, b)),
        _ => panic!("original close origin changed"),
    }
}
fn company_close_error() -> ResourceActorError {
    use reverie_store::{StoreError, StoreFault, storage_identity::IdentityError};
    let error = IdentityError::Finalization {
        primary: Box::new(IdentityError::Io(std::io::Error::other("known body error"))),
        secondary: Box::new(IdentityError::Custody(StoreError::CloseUnconfirmed {
            cause: Box::new(StoreError::Refused(StoreFault::PrivateFile)),
        })),
    };
    GateError::from(error).into()
}
#[test]
fn actual_q_record_known_stateless_io_remains_closeable_without_native_or_owner_grant() {
    crate::test_process::owning_case!(
        actual_q_record_known_stateless_io_remains_closeable_without_native_or_owner_grant
    );
    let fixture = Fixture::new();
    let (mut client, connection) = fixture.accept(b'Q', b"{}");
    let mut failure = fixture
        .broker
        .prepare_resource_website(connection)
        .err()
        .unwrap();
    let cause = reverie_host::ObservationError::Io(std::io::Error::other("ordinary IO"));
    let kernel = reverie_host::reservation_kernel::ReservationKernelError::from(cause);
    let observed = crate::reservation_observer::ObserverError::from(kernel);
    let body = failure
        .frame
        .retain_stateless_result::<()>(Err(observed.into()));
    assert!(!body.unwrap_err().has_unconfirmed_close());
    assert!(failure.frame.unconfirmed.is_none());
    close(&mut failure, &mut client);
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
