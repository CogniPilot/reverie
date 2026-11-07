//! Actual configured Gate and shared native Runtime. The fixed test engine's
//! empty container inventory and name membership are synthetic read-side DATA;
//! no real container/process or start permission is inferred from those replies.
use super::*;
use reverie_contracts::reservation_engine::ReservationConfiguration;
use reverie_host::reservation_control::AdmissionLock;
struct Reserved {
    tree: crate::reservation_gate::tests::Tree,
    broker: Arc<InstallingBroker>,
}
impl Reserved {
    fn new(names: &str) -> Self {
        let tree = crate::reservation_gate::tests::Tree::new();
        tree.write("company.json", br#"{"employees":[]}"#);
        tree.write("ids.out", b"");
        tree.write("names.out", names.as_bytes());
        let snapshot =
            crate::worker_validation::load_owner_config(&tree.root.join("worker.json")).unwrap();
        let bootstrap = EngineBootstrap::from_service(
            program().as_os_str(),
            BTreeMap::new(),
            tree.root.clone(),
        )
        .unwrap();
        let runtime = WorkerRuntime::new(
            InstalledWorkerEngine::new(bootstrap),
            snapshot.envelope().base(),
        );
        let broker = Arc::new(InstallingBroker::new(snapshot, runtime).unwrap());
        assert!(broker.resource_reservations().unwrap().is_some());
        Self { tree, broker }
    }
    fn config(&self) -> ReservationConfiguration {
        ReservationConfiguration::capture(
            self.broker.configuration().unwrap().configuration().clone(),
        )
    }
    fn calls(&self) -> Vec<String> {
        fs::read_to_string(self.tree.root.join("calls.txt"))
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect()
    }
    fn start_held(&self) -> std::thread::JoinHandle<Result<RecoverySummary>> {
        self.tree.write("names.hold", b"actual held names query");
        let broker = self.broker.clone();
        std::thread::spawn(move || broker.recover_laptops())
    }
    fn entered(&self) -> bool {
        let end = Instant::now() + Duration::from_secs(10);
        while !self.tree.root.join("names.started").exists() && Instant::now() < end {
            std::thread::sleep(Duration::from_millis(2));
        }
        self.tree.root.join("names.started").exists()
    }
    fn release(&self) {
        self.tree
            .write("names.release", b"always settle the original query");
    }
    fn journal(&self) -> Vec<u8> {
        fs::read(self.tree.root.join("control/operations/operations.json")).unwrap()
    }
    fn assert_lock_free(&self) {
        AdmissionLock::acquire(&self.config())
            .unwrap()
            .close()
            .unwrap();
    }
}
impl Drop for Reserved {
    fn drop(&mut self) {
        if let Some(office) = self.broker.recovery.office.lock().unwrap().as_ref() {
            office
                .close(Instant::now() + Duration::from_secs(5))
                .unwrap();
        }
        self.broker
            .storage
            .runtime
            .close(Instant::now() + Duration::from_secs(5))
            .unwrap();
    }
}
#[test]
fn actual_installed_gate_holds_admission_through_recovery_and_success_finalizer() {
    crate::test_process::owning_case!(
        actual_installed_gate_holds_admission_through_recovery_and_success_finalizer
    );
    let owned = Reserved::new(&format!("test-agent-{FIRST}\n"));
    let before = owned.journal();
    let worker = owned.start_held();
    let entered = owned.entered();
    let busy = if entered {
        match AdmissionLock::acquire(&owned.config()) {
            Err(error) => error.code() == "RESERVATION_ADMISSION_LOCK_BUSY",
            Ok(mut lock) => {
                lock.close().unwrap();
                false
            }
        }
    } else {
        false
    };
    owned.release();
    let result = worker.join().unwrap();
    assert!(entered, "original supervised names query entered");
    assert!(busy, "actual configured admission flock remains held");
    assert_eq!(
        result
            .unwrap_or_else(|error| panic!("{error:?}"))
            .registered(),
        1
    );
    let calls = owned.calls();
    let names = calls
        .iter()
        .position(|call| call.starts_with("ps\0--filter"))
        .unwrap();
    assert!(
        names > 0,
        "entry/journal guards precede running-name census"
    );
    assert!(
        calls[names + 1..]
            .iter()
            .any(|call| call == "ps\0-aq\0--no-trunc"),
        "check_launch/final admission guards execute afterward"
    );
    assert_eq!(owned.journal(), before);
    assert!(!owned.tree.root.join("state/storage-locks").exists());
    owned.assert_lock_free();
}
#[test]
fn actual_installed_gate_rejects_nil_and_aborts_without_success_guard_or_phone() {
    crate::test_process::owning_case!(
        actual_installed_gate_rejects_nil_and_aborts_without_success_guard_or_phone
    );
    let owned = Reserved::new("00000000-0000-0000-0000-000000000000\n");
    let before = owned.journal();
    let error = owned.broker.recover_laptops().err().unwrap();
    assert!(
        matches!(error, RecoveryError::Gate(GateError::Operation(_))),
        "{error:?}"
    );
    assert!(owned.calls().last().unwrap().starts_with("ps\0--filter"));
    assert!(owned.broker.installed.lifecycle().unwrap().guard.is_empty());
    assert!(!owned.tree.root.join("office").exists());
    assert_eq!(owned.journal(), before);
    owned.assert_lock_free();
}
#[test]
fn actual_installed_gate_malformed_journal_refuses_before_census_and_closes_admission() {
    crate::test_process::owning_case!(
        actual_installed_gate_malformed_journal_refuses_before_census_and_closes_admission
    );
    let owned = Reserved::new(&format!("test-agent-{FIRST}\n"));
    owned.tree.write("control/operations/operations.json", b"{");
    let error = owned.broker.recover_laptops().err().unwrap();
    assert!(
        matches!(error, RecoveryError::Gate(GateError::Journal(_))),
        "{error:?}"
    );
    assert!(!owned.calls().is_empty(), "actual entry custody ran");
    assert!(
        owned
            .calls()
            .iter()
            .all(|call| !call.starts_with("ps\0--filter"))
    );
    assert!(!owned.tree.root.join("office").exists());
    assert_eq!(owned.journal(), b"{");
    owned.assert_lock_free();
}
#[test]
fn actual_installed_gate_final_guard_failure_keeps_committed_phone_and_consumes_admission() {
    crate::test_process::owning_case!(
        actual_installed_gate_final_guard_failure_keeps_committed_phone_and_consumes_admission
    );
    let owned = Reserved::new(&format!("test-agent-{FIRST}\n"));
    let before = owned.journal();
    // The fixed fixture changes only its actual next native inventory response
    // AFTER observing the genuine socket. No guessed query index or supplied
    // native result replaces the production final guard.
    owned
        .tree
        .write("reject-after-phone", b"final native guard");
    let error = owned.broker.recover_laptops().err().unwrap();
    assert!(
        matches!(error, RecoveryError::Gate(GateError::Observer(_))),
        "{error:?}"
    );
    assert_eq!(owned.broker.installed.lifecycle().unwrap().guard.len(), 1);
    assert!(
        fs::symlink_metadata(
            owned
                .tree
                .root
                .join("office")
                .join(FIRST)
                .join("office.sock")
        )
        .unwrap()
        .file_type()
        .is_socket()
    );
    assert_eq!(owned.journal(), before);
    owned.assert_lock_free();
}
#[test]
fn actual_installed_gate_body_and_poisoned_lock_cleanup_errors_both_survive() {
    crate::test_process::owning_case!(
        actual_installed_gate_body_and_poisoned_lock_cleanup_errors_both_survive
    );
    let owned = Reserved::new("00000000-0000-0000-0000-000000000000\n");
    let before = owned.journal();
    let worker = owned.start_held();
    let entered = owned.entered();
    if entered {
        owned
            .broker
            .resource_reservations()
            .unwrap()
            .unwrap()
            .poison_recovery_cleanup_for_test();
    }
    owned.release();
    let result = worker.join().unwrap();
    // The actual close_active poison branch must consume the original FD even
    // while reporting its typed cleanup refusal.
    owned.assert_lock_free();
    assert!(entered, "actual names query, not a guessed native stage");
    let error = result.err().unwrap();
    let RecoveryError::Finalization { primary, secondary } = error else {
        panic!("{error:?}")
    };
    assert!(
        matches!(*primary, RecoveryError::Gate(GateError::Operation(_))),
        "{primary:?}"
    );
    assert!(
        matches!(
            *secondary,
            RecoveryError::Gate(GateError::Refused("RESERVATION_ADMISSION_UNAVAILABLE"))
        ),
        "{secondary:?}"
    );
    assert!(!owned.tree.root.join("office").exists());
    assert_eq!(owned.journal(), before);
}
