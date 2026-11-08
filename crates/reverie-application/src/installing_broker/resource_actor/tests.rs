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
    for cause in [
        observed.into(),
        company_close_error(),
        control_close_error(),
    ] {
        let (mut client, connection) = fixture.accept(b'Q', b"{}");
        let mut failure = fixture
            .broker
            .prepare_resource_website(connection)
            .err()
            .unwrap();
        let original_code = cause.code();
        let body = failure.frame.retain_stateless_result::<()>(Err(cause));
        let first = failure.close_channel_component(end());
        let eof = client.read(&mut [0]);
        let repeated = failure.close_channel_component(end());
        let retained = failure.frame.unconfirmed.clone();
        let body = body.unwrap_err();
        assert!(body.has_unconfirmed_close());
        assert_eq!(body.code(), original_code);
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
        (RetainedClose::Gate(a), RetainedClose::Gate(b)) => assert!(Arc::ptr_eq(a, b)),
        (RetainedClose::Company(a), RetainedClose::Company(b)) => assert!(Arc::ptr_eq(a, b)),
        (RetainedClose::Kernel(a), RetainedClose::Kernel(b)) => assert!(Arc::ptr_eq(a, b)),
        (RetainedClose::Control(a), RetainedClose::Control(b)) => assert!(Arc::ptr_eq(a, b)),
        _ => panic!("original close origin changed"),
    }
}

#[test]
fn actual_q_dispatch_reconciliation_keeps_original_hold_and_bounded_diagnostics() {
    crate::test_process::owning_case!(
        actual_q_dispatch_reconciliation_keeps_original_hold_and_bounded_diagnostics
    );
    let mut fixture = Fixture::new();
    fixture.retained = true;
    let (mut client, connection) = fixture.accept(b'Q', b"{}");
    let mut entry = fixture
        .broker
        .prepare_resource_website(connection)
        .err()
        .unwrap();
    let primary = entry.cause().code();
    // Actual accepted Record/peer/hold; this is typed negative composition,
    // not another native close producer or a successful Auth fixture.
    let cleanup = company_close_error();
    let cleanup_code = cleanup.code();
    assert!(
        entry
            .frame
            .retain_stateless_result::<()>(Err(cleanup))
            .unwrap_err()
            .has_unconfirmed_close()
    );
    let mut retained = ResourceOperationFailure::from_entry(entry);
    let mut first_length = None;
    for attempt in 1..=256 {
        retained = match retained.settle_for_worker() {
            Err(owner) => owner,
            Ok(_) => panic!("uncertain original owner must remain counted"),
        };
        let diagnostic = retained.to_string();
        assert!(diagnostic.contains(primary));
        assert!(diagnostic.contains(cleanup_code));
        assert!(diagnostic.ends_with(&format!("failed closes: {attempt}")));
        let first_length = *first_length.get_or_insert(diagnostic.len());
        assert!(diagnostic.len() <= first_length + 3);
    }
    assert_eq!(client.read(&mut [0]).unwrap(), 0);
}

#[test]
fn actual_q_preview_gate_close_errors_keep_original_frame_hold_and_cause() {
    crate::test_process::owning_case!(
        actual_q_preview_gate_close_errors_keep_original_frame_hold_and_cause
    );
    let mut fixture = Fixture::new();
    fixture.retained = true;
    // Classification composition only. The intrinsic consumed-close producers
    // are separately exercised by actual Store/Host native controls.
    let profile = GateError::Profile(profile_close_data());
    let journal = GateError::Journal(reverie_store::operations::JournalError::Filesystem(
        profile_close_data(),
    ));
    let kernel = gate_kernel_close_error();
    let guard = gate_kernel_close_error();
    let guarded = GateError::Journal(reverie_store::operations::JournalError::guard_failure(
        guard.code(),
        guard,
    ));
    for cause in [profile, journal, kernel, guarded] {
        let (mut client, connection) = fixture.accept(b'Q', b"{}");
        let mut failure = fixture
            .broker
            .prepare_resource_website(connection)
            .err()
            .unwrap();
        let original = cause.code();
        let body = failure
            .frame
            .retain_stateless_result::<()>(Err(cause.into()))
            .unwrap_err();
        assert_eq!(body.code(), original);
        assert!(body.has_unconfirmed_close());
        let retained = failure.frame.unconfirmed.clone().unwrap();
        assert!(
            failure
                .close_channel_component(end())
                .unwrap_err()
                .has_unconfirmed_close()
        );
        assert_eq!(client.read(&mut [0]).unwrap(), 0);
        assert!(
            failure
                .close_channel_component(end())
                .unwrap_err()
                .has_unconfirmed_close()
        );
        assert_same_close(&retained, failure.frame.unconfirmed.as_ref().unwrap());
    }
}
fn profile_close_data() -> reverie_store::StoreError {
    reverie_store::StoreError::CloseUnconfirmed {
        cause: Box::new(reverie_store::StoreError::Refused(
            reverie_store::StoreFault::PrivateFile,
        )),
    }
}
fn gate_kernel_close_error() -> GateError {
    let cause = reverie_host::ObservationError::CloseUnconfirmed {
        cause: std::io::Error::other("typed Gate kernel consumed-close witness"),
    };
    let kernel = reverie_host::reservation_kernel::ReservationKernelError::from(cause);
    GateError::Observer(crate::reservation_observer::ObserverError::from(kernel))
}
#[test]
fn actual_q_preview_known_profile_journal_and_kernel_errors_do_not_invent_unknown() {
    crate::test_process::owning_case!(
        actual_q_preview_known_profile_journal_and_kernel_errors_do_not_invent_unknown
    );
    let fixture = Fixture::new();
    let profile = GateError::Profile(reverie_store::StoreError::Refused(
        reverie_store::StoreFault::PrivateFile,
    ));
    let journal = GateError::Journal(reverie_store::operations::JournalError::Filesystem(
        reverie_store::StoreError::Refused(reverie_store::StoreFault::LockBusy),
    ));
    let native =
        reverie_host::ObservationError::Io(std::io::Error::other("known native body refusal"));
    let kernel = GateError::Observer(crate::reservation_observer::ObserverError::from(
        reverie_host::reservation_kernel::ReservationKernelError::from(native),
    ));
    for cause in [profile, journal, kernel] {
        let (mut client, connection) = fixture.accept(b'Q', b"{}");
        let mut failure = fixture
            .broker
            .prepare_resource_website(connection)
            .err()
            .unwrap();
        let body = failure
            .frame
            .retain_stateless_result::<()>(Err(cause.into()))
            .unwrap_err();
        assert!(!body.has_unconfirmed_close());
        assert!(failure.frame.unconfirmed.is_none());
        failure.close_channel_component(end()).unwrap();
        assert_eq!(client.read(&mut [0]).unwrap(), 0);
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
fn control_close_data() -> reverie_host::reservation_control::ControlHostError {
    use reverie_host::{ObservationError, reservation_control::ControlHostError};
    ControlHostError::Finalization {
        primary: Box::new(ControlHostError::Native(ObservationError::Io(
            std::io::Error::other("known control body"),
        ))),
        secondary: Box::new(ControlHostError::PoolTransitionClose(Arc::new(
            ObservationError::CloseUnconfirmed {
                cause: std::io::Error::other("typed consumed control close witness"),
            },
        ))),
    }
}
fn control_close_error() -> ResourceActorError {
    GateError::Finalization {
        primary: Box::new(GateError::Refused("KNOWN_GATE_BODY")),
        secondary: Box::new(GateError::Control(control_close_data())),
    }
    .into()
}
#[test]
fn control_close_classifier_recurses_both_gate_branches_without_changing_primary_code() {
    for secondary in [false, true] {
        let close = Box::new(GateError::Control(control_close_data()));
        let known = Box::new(GateError::Refused("KNOWN_GATE_BODY"));
        let (primary, secondary) = if secondary {
            (known, close)
        } else {
            (close, known)
        };
        let original = GateError::Finalization { primary, secondary };
        let code = original.code();
        let actual = ResourceActorError::from(original);
        assert!(actual.has_unconfirmed_close());
        assert_eq!(actual.code(), code);
    }
    let known = GateError::Control(reverie_host::reservation_control::ControlHostError::Native(
        reverie_host::ObservationError::Io(std::io::Error::other("ordinary IO")),
    ));
    assert!(!ResourceActorError::from(known).has_unconfirmed_close());
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
