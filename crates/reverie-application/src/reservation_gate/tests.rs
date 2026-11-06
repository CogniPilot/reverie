use super::*;
use crate::{
    reservation_observer::tests::Fixture,
    worker_validation::{load_owner_config, validate_captured},
};
use reverie_contracts::{operations_v1, worker_config};
use reverie_core::operations::OperationDocument;
use std::{
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};
static NEXT: AtomicU64 = AtomicU64::new(0);
#[path = "tests_observation.rs"]
mod observation_cases;
pub(crate) struct Tree {
    pub(crate) root: PathBuf,
    pub(crate) raw: Vec<u8>,
}
impl Tree {
    pub(crate) fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "reverie-gate-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        for name in [
            "",
            "state",
            "control",
            "control/profiles",
            "control/operations",
            "work",
        ] {
            let path = root.join(name);
            if !name.is_empty() {
                fs::create_dir(&path).unwrap();
            }
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let base: serde_json::Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/worker_validation/loader.json"
        ))
        .unwrap();
        let mut config: serde_json::Value = serde_json::from_str(
            &base[0]["expected"]
                .as_str()
                .unwrap()
                .replace("$ROOT", root.to_str().unwrap()),
        )
        .unwrap();
        config["uid"] = serde_json::json!(fs::metadata(&root).unwrap().uid());
        config["resourceReservations"] = serde_json::json!({"directory":root.join("control"),"companyId":"11111111-2222-4333-8444-555555555555","poolId":"22222222-2222-4333-8444-555555555555","ownerScopeDigest":"d".repeat(64),"hostReserveMiB":64});
        let tree = Self {
            root,
            raw: serde_json::to_vec(&config).unwrap(),
        };
        for name in [
            "control/admission.lock",
            "control/profiles/profiles.lock",
            "control/operations/operations.lock",
        ] {
            tree.write(name, b"");
        }
        tree.write(
            "control/operations/operations.json",
            &operations_v1::encode(&OperationDocument::empty()).unwrap(),
        );
        tree.write("worker.json", &tree.raw);
        tree.marker(&config);
        tree
    }
    pub(crate) fn write(&self, name: &str, raw: &[u8]) {
        let path = self.root.join(name);
        fs::write(&path, raw).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }
    fn identity(&self, name: &str) -> serde_json::Value {
        let info = fs::symlink_metadata(self.root.join(name)).unwrap();
        serde_json::json!([info.dev(), info.ino()])
    }
    pub(crate) fn marker(&self, config: &serde_json::Value) {
        let checked = worker_config::decode(&self.raw).unwrap();
        let marker = serde_json::json!({"schema":"reverie-resource-control-v1","state":"READY","option":config["resourceReservations"],"directories":{".":self.identity("control"),"profiles":self.identity("control/profiles"),"operations":self.identity("control/operations")},"admissionLock":self.identity("control/admission.lock"),"stateDirectory":self.identity("state"),"locks":{"profiles":self.identity("control/profiles/profiles.lock"),"operations":self.identity("control/operations/operations.lock")},"configurationDigest":domain_digest(&checked).unwrap().to_hex()});
        self.write(
            "state/resource-reservation-control.json",
            &serde_json::to_vec(&marker).unwrap(),
        );
    }
    pub(crate) fn gate(&self, fixture: &Arc<Fixture>, loaded: bool) -> ReservationGate {
        let snapshot = if loaded {
            load_owner_config(&self.root.join("worker.json")).unwrap()
        } else {
            validate_captured(worker_config::decode(&self.raw).unwrap()).unwrap()
        };
        ReservationGate::new(snapshot, fixture.observer()).unwrap()
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}
fn prepare(fixture: &Fixture, censuses: usize) {
    for _ in 0..censuses {
        fixture.inventory(&[]);
    }
}
fn key() -> JournalId {
    JournalId::parse("33333333-2222-4333-8444-555555555555").unwrap()
}
#[test]
fn installing_broker_and_reserved_gate_share_one_current_snapshot_owner() {
    use reverie_host::{
        engine_metadata::EngineBootstrap, installed_worker_engine::InstalledWorkerEngine,
        worker_runtime::WorkerRuntime,
    };
    let tree = Tree::new();
    let snapshot = load_owner_config(&tree.root.join("worker.json")).unwrap();
    let bootstrap = EngineBootstrap::from_service(
        std::env::current_exe().unwrap().as_os_str(),
        std::collections::BTreeMap::new(),
        tree.root.clone(),
    )
    .unwrap();
    let runtime = WorkerRuntime::new(
        InstalledWorkerEngine::new(bootstrap),
        snapshot.envelope().base(),
    );
    let broker = crate::installing_broker::InstallingBroker::new(snapshot, runtime).unwrap();
    let gate = broker.resource_reservations().unwrap().unwrap();
    assert!(
        Arc::ptr_eq(
            &broker.configuration().unwrap(),
            &gate.inner.installed.snapshot().unwrap()
        ),
        "both public service views retain the exact same validated snapshot, not a second load/capture"
    );
    gate.settle_owned(Instant::now() + Duration::from_secs(2))
        .unwrap();
}

#[test]
fn readonly_lookup_uses_actual_admission_canonical_store_and_final_guard() {
    crate::test_process::owning_case!(
        readonly_lookup_uses_actual_admission_canonical_store_and_final_guard
    );
    let tree = Tree::new();
    let fixture = Fixture::new();
    prepare(&fixture, 8);
    let gate = tree.gate(&fixture, true);
    assert!(gate.inspect(&key()).unwrap().is_none());
    assert!(gate.inner.state.lock().unwrap().active.is_none());
    assert_eq!(
        fixture.events().len(),
        20,
        "entry, two journal guards, and terminal admission guard"
    );
    let mut lock = AdmissionLock::acquire(&gate.inner.config().unwrap()).unwrap();
    lock.close().unwrap();
    assert_eq!(fs::read(tree.root.join("worker.json")).unwrap(), tree.raw);
}
#[test]
fn reentrant_and_expired_admission_refuse_before_new_native_queries() {
    crate::test_process::owning_case!(
        reentrant_and_expired_admission_refuse_before_new_native_queries
    );
    let tree = Tree::new();
    let fixture = Fixture::new();
    prepare(&fixture, 4);
    let gate = tree.gate(&fixture, false);
    assert_eq!(
        gate.inner
            .admit(AdmissionBounds {
                operation: Some(Instant::now() - Duration::from_secs(1)),
                entry: None
            })
            .err()
            .unwrap()
            .code(),
        "RESERVATION_ADMISSION_DEADLINE"
    );
    assert!(fixture.events().is_empty());
    let first = gate.inner.admit(AdmissionBounds::default()).unwrap();
    let events = fixture.events();
    assert_eq!(
        gate.inspect(&key()).unwrap_err().code(),
        "RESERVATION_REENTRANT_ADMISSION"
    );
    assert_eq!(fixture.events(), events);
    first.finish().unwrap();
}
#[test]
fn entry_bound_does_not_become_a_new_body_or_finalizer_deadline() {
    crate::test_process::owning_case!(entry_bound_does_not_become_a_new_body_or_finalizer_deadline);
    let tree = Tree::new();
    let fixture = Fixture::new();
    prepare(&fixture, 4);
    let gate = tree.gate(&fixture, false);
    let entry = Instant::now() + Duration::from_secs(5);
    let admission = gate
        .inner
        .admit(AdmissionBounds {
            operation: None,
            entry: Some(entry),
        })
        .unwrap();
    assert!(
        gate.inner
            .held(None)
            .unwrap()
            .deadline
            .lock()
            .unwrap()
            .is_none()
    );
    assert!(fixture.deadlines().iter().all(|end| *end == entry));
    admission.finish().unwrap();
    let ends = fixture.deadlines();
    assert_eq!(ends.len(), 4);
    assert!(ends[2..].iter().all(|end| *end > entry));
}
#[test]
fn changed_image_and_pending_refuse_and_release_the_actual_flock() {
    crate::test_process::owning_case!(
        changed_image_and_pending_refuse_and_release_the_actual_flock
    );
    let tree = Tree::new();
    let fixture = Fixture::new();
    let gate = tree.gate(&fixture, true);
    tree.write("state/resource-reservation-control.pending", b"{}");
    assert_eq!(
        gate.inspect(&key()).unwrap_err().code(),
        "RESERVATION_INSTALL_REQUIRES_RECONCILIATION"
    );
    assert!(fixture.events().is_empty());
    fs::remove_file(tree.root.join("state/resource-reservation-control.pending")).unwrap();
    tree.write("worker.json", b"{\"image\":\"foreign\"}");
    assert_eq!(
        gate.inspect(&key()).unwrap_err().code(),
        "WORKER_IMAGE_CONFIGURATION_STALE"
    );
    assert!(fixture.events().is_empty());
    assert!(gate.inner.state.lock().unwrap().active.is_none());
    let mut lock = AdmissionLock::acquire(&gate.inner.config().unwrap()).unwrap();
    lock.close().unwrap();
}
#[test]
fn failed_body_closes_store_and_admission_without_success_native_finalizer_queries() {
    crate::test_process::owning_case!(
        failed_body_closes_store_and_admission_without_success_native_finalizer_queries
    );
    let tree = Tree::new();
    let fixture = Fixture::new();
    prepare(&fixture, 4);
    let gate = tree.gate(&fixture, true);
    tree.write("control/operations/operations.json", b"{");
    assert!(matches!(gate.inspect(&key()), Err(GateError::Journal(_))));
    assert_eq!(
        fixture.events().len(),
        10,
        "only entry and first journal scope guard ran"
    );
    assert!(gate.inner.state.lock().unwrap().active.is_none());
    let mut lock = AdmissionLock::acquire(&gate.inner.config().unwrap()).unwrap();
    lock.close().unwrap();
}
#[test]
fn another_thread_cannot_borrow_the_live_scope_and_waiting_is_bounded() {
    crate::test_process::owning_case!(
        another_thread_cannot_borrow_the_live_scope_and_waiting_is_bounded
    );
    let tree = Tree::new();
    let fixture = Fixture::new();
    prepare(&fixture, 4);
    let gate = tree.gate(&fixture, false);
    let admission = gate.inner.admit(AdmissionBounds::default()).unwrap();
    let inner = gate.inner.clone();
    std::thread::spawn(move || {
        assert_eq!(
            inner.held(Some(&inner.scope)).err().unwrap().code(),
            "RESERVATION_ADMISSION_LOCK_REQUIRED"
        );
        assert_eq!(
            inner
                .admit(AdmissionBounds {
                    operation: None,
                    entry: Some(Instant::now() + Duration::from_millis(30))
                })
                .err()
                .unwrap()
                .code(),
            "RESERVATION_ADMISSION_DEADLINE"
        );
    })
    .join()
    .unwrap();
    admission.finish().unwrap();
}
#[test]
fn waiting_remains_bounded_before_native_flock_open_and_entry_is_not_admission() {
    crate::test_process::owning_case!(
        waiting_remains_bounded_before_native_flock_open_and_entry_is_not_admission
    );
    let tree = Tree::new();
    let fixture = Fixture::new();
    let gate = tree.gate(&fixture, false);
    let entry = gate.inner.reserve_entry(None).unwrap();
    assert_eq!(
        gate.inner.held(None).err().unwrap().code(),
        "RESERVATION_ADMISSION_LOCK_REQUIRED"
    );
    let inner = gate.inner.clone();
    std::thread::spawn(move || {
        assert_eq!(
            inner
                .admit(AdmissionBounds {
                    operation: None,
                    entry: Some(Instant::now() + Duration::from_millis(30))
                })
                .err()
                .unwrap()
                .code(),
            "RESERVATION_ADMISSION_DEADLINE"
        );
    })
    .join()
    .unwrap();
    assert!(fixture.events().is_empty());
    entry.cancel().unwrap();
    let state = gate.inner.state.lock().unwrap();
    assert!(state.entering.is_none() && state.active.is_none());
}
#[test]
fn failed_actual_lock_open_releases_only_its_owned_entry_registration() {
    crate::test_process::owning_case!(
        failed_actual_lock_open_releases_only_its_owned_entry_registration
    );
    let tree = Tree::new();
    let fixture = Fixture::new();
    let gate = tree.gate(&fixture, false);
    fs::remove_file(tree.root.join("control/admission.lock")).unwrap();
    assert!(gate.inspect(&key()).is_err());
    let state = gate.inner.state.lock().unwrap();
    assert!(state.entering.is_none() && state.active.is_none());
    assert!(fixture.events().is_empty());
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoragePhaseCase {
    name: String,
    company_raw: String,
    company_mode: u32,
    state: String,
    scratch: String,
    history_raw: Option<String>,
    error: serde_json::Value,
}
#[test]
fn strict_storage_constructor_retains_its_eager_path_contract() {
    let tree = Tree::new();
    let cases: Vec<StoragePhaseCase> = serde_json::from_str(include_str!(
        "../../tests/fixtures/worker_validation/storage-phase-python.json"
    ))
    .unwrap();
    assert_eq!(cases.len(), 5);
    let company = tree.root.join("company.json");
    fs::create_dir(tree.root.join("scratch")).unwrap();
    for case in cases {
        fs::write(&company, case.company_raw).unwrap();
        fs::set_permissions(&company, fs::Permissions::from_mode(case.company_mode)).unwrap();
        let history = tree.root.join("plan-moves.json");
        if history.exists() {
            fs::remove_file(&history).unwrap();
        }
        if let Some(raw) = case.history_raw {
            fs::write(&history, raw).unwrap();
            fs::set_permissions(history, fs::Permissions::from_mode(0o600)).unwrap();
        }
        let result = reverie_store::storage_identity::StorageIdentityConfig::try_new(
            company.clone(),
            tree.root.join(case.state),
            tree.root.join(case.scratch),
            fs::metadata(&tree.root).unwrap().uid(),
        );
        assert_eq!(
            result.err().unwrap().code(),
            "CANONICAL_STORAGE_PATH",
            "{}",
            case.name
        );
        eprintln!(
            "{}: strict Rust constructor=CANONICAL_STORAGE_PATH; actual old storage_paths={}",
            case.name, case.error
        );
    }
}
fn deferred_storage(
    tree: &Tree,
    state: &str,
    scratch: &str,
) -> reverie_store::storage_identity::StorageIdentityConfig {
    let mut raw: serde_json::Value = serde_json::from_slice(&tree.raw).unwrap();
    raw["companyFile"] = serde_json::json!(tree.root.join("company.json"));
    raw["stateRoot"] = serde_json::json!(tree.root.join(state));
    raw["scratchRoot"] = serde_json::json!(tree.root.join(scratch));
    let source = worker_config::decode(&serde_json::to_vec(&raw).unwrap()).unwrap();
    let captured =
        reverie_contracts::resource_config::ResourceConfiguration::capture(source).unwrap();
    reverie_store::storage_identity::StorageIdentityConfig::capture_worker_settings(
        &captured.identity_settings().unwrap(),
    )
}
#[test]
fn captured_storage_settings_restore_original_metadata_then_path_order() {
    let tree = Tree::new();
    fs::create_dir(tree.root.join("scratch")).unwrap();
    let cases: Vec<StoragePhaseCase> = serde_json::from_str(include_str!(
        "../../tests/fixtures/worker_validation/storage-phase-python.json"
    ))
    .unwrap();
    let session =
        reverie_core::ids::ProfileSessionId::parse("11111111-2222-4333-8444-555555555555").unwrap();
    for case in cases {
        tree.write("company.json", case.company_raw.as_bytes());
        fs::set_permissions(
            tree.root.join("company.json"),
            fs::Permissions::from_mode(case.company_mode),
        )
        .unwrap();
        let history = tree.root.join("plan-moves.json");
        if history.exists() {
            fs::remove_file(&history).unwrap();
        }
        if let Some(raw) = case.history_raw {
            tree.write("plan-moves.json", raw.as_bytes());
        }
        let input = deferred_storage(&tree, &case.state, &case.scratch);
        let expected = match case.name.as_str() {
            "malformed-company-before-state-spelling"
            | "malformed-history-before-state-spelling" => "METADATA_JSON",
            "bad-registry-before-state-spelling" => "EMPLOYEE_REGISTRY",
            "bad-company-custody-before-scratch-spelling" => "TRUSTED_STORAGE_METADATA",
            "state-spelling-after-valid-company" => "CANONICAL_STORAGE_PATH",
            _ => panic!("unknown oracle case"),
        };
        assert_eq!(
            reverie_store::storage_identity::storage_paths(&input, &session)
                .unwrap_err()
                .code(),
            expected,
            "{}",
            case.name
        );
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct EncodingPhaseCase {
    key: String,
    tail: Vec<u32>,
    history_error: serde_json::Value,
    after_history_error: serde_json::Value,
}
fn encoded_settings(
    tree: &Tree,
    key: &str,
    tail: &[u32],
) -> reverie_store::storage_identity::StorageIdentityConfig {
    let mut raw: serde_json::Value = serde_json::from_slice(&tree.raw).unwrap();
    raw["companyFile"] = serde_json::json!(tree.root.join("company.json"));
    raw["scratchRoot"] = serde_json::json!(tree.root.join("scratch"));
    raw[key] = serde_json::json!("__CAPTURED_PATH__");
    let points = tree
        .root
        .to_str()
        .unwrap()
        .chars()
        .map(u32::from)
        .chain(tail.iter().copied());
    let literal = format!(
        "\"{}\"",
        points
            .map(|point| format!("\\u{point:04x}"))
            .collect::<String>()
    );
    let json = serde_json::to_string(&raw)
        .unwrap()
        .replace("\"__CAPTURED_PATH__\"", &literal);
    let captured = reverie_contracts::resource_config::ResourceConfiguration::capture(
        worker_config::decode(json.as_bytes()).unwrap(),
    )
    .unwrap();
    reverie_store::storage_identity::StorageIdentityConfig::capture_worker_settings(
        &captured.identity_settings().unwrap(),
    )
}
#[test]
fn captured_path_data_defers_encoding_and_preserves_index_lookup_valueerror_semantics() {
    let tree = Tree::new();
    fs::create_dir(tree.root.join("scratch")).unwrap();
    tree.write("company.json", br#"{"employees":[]}"#);
    let cases: Vec<EncodingPhaseCase> = serde_json::from_str(include_str!(
        "../../tests/fixtures/worker_validation/storage-encoding-phase-python.json"
    ))
    .unwrap();
    assert_eq!(cases.len(), 6);
    let sid =
        reverie_core::ids::ProfileSessionId::parse("11111111-2222-4333-8444-555555555555").unwrap();
    for case in cases {
        let input = encoded_settings(&tree, &case.key, &case.tail);
        tree.write("plan-moves.json", b"{");
        assert_eq!(case.history_error["type"], "JSONDecodeError");
        assert_eq!(
            reverie_store::storage_identity::storage_paths(&input, &sid)
                .unwrap_err()
                .code(),
            "METADATA_JSON",
            "{} {:?}",
            case.key,
            case.tail
        );
        fs::remove_file(tree.root.join("plan-moves.json")).unwrap();
        let expected =
            if case.after_history_error["message"] == "Canonical laptop storage path required" {
                "CANONICAL_STORAGE_PATH"
            } else {
                "STORAGE_IDENTITY_IO"
            };
        assert_eq!(
            reverie_store::storage_identity::storage_paths(&input, &sid)
                .unwrap_err()
                .code(),
            expected,
            "{} {:?}: {}",
            case.key,
            case.tail,
            case.after_history_error
        );
    }
}

#[test]
fn normalized_index_lookup_precedes_raw_state_path_canonical_check() {
    let tree = Tree::new();
    fs::create_dir(tree.root.join("scratch")).unwrap();
    tree.write("company.json", br#"{"employees":[]}"#);
    let sid =
        reverie_core::ids::ProfileSessionId::parse("11111111-2222-4333-8444-555555555555").unwrap();
    let directory = tree.root.join("state").join(sid.as_str());
    fs::create_dir(&directory).unwrap();
    let owner = directory.join("storage-owner.json");
    fs::write(&owner, b"{").unwrap();
    fs::set_permissions(&owner, fs::Permissions::from_mode(0o600)).unwrap();
    let input = deferred_storage(&tree, "state//./", "scratch");
    assert_eq!(
        reverie_store::storage_identity::storage_paths(&input, &sid)
            .unwrap_err()
            .code(),
        "METADATA_JSON"
    );
    fs::remove_file(owner).unwrap();
    assert_eq!(
        reverie_store::storage_identity::storage_paths(&input, &sid)
            .unwrap_err()
            .code(),
        "CANONICAL_STORAGE_PATH"
    );
}
