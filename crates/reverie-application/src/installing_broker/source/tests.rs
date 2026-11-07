//! Actual installed bootstrap/recovery/resource claim, with SAME captured
//! metadata client. Kernel facts alone are synthetic: this does not qualify a
//! running container, native stop, source release or protected launch.
use super::*;
#[path = "phase_tests.rs"]
mod phase;
#[path = "stop_tests.rs"]
mod stop;
use crate::{
    reservation_gate::tests::observation_cases::Setup, reservation_observer::tests::Fixture,
};
use reverie_contracts::{
    operations_v1, reservation_baseline::OriginalRuntimeTail,
    reservation_engine::ReservationConfiguration,
};
use reverie_host::{
    engine_metadata::EngineBootstrap, installed_worker_engine::InstalledWorkerEngine,
    reservation_control::AdmissionLock, worker_runtime::WorkerRuntime,
    worker_storage::StorageLease,
};
use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    time::{Duration, Instant},
};

struct Owned {
    setup: Setup,
    broker: Arc<InstallingBroker>,
    fixture: Arc<Fixture>,
}
impl Owned {
    fn new() -> Self {
        let setup = Setup::new();
        let eid = setup.oracle["employee"]["id"].as_str().unwrap();
        for path in [
            "state/employees".to_owned(),
            format!("state/employees/{eid}"),
            "scratch".to_owned(),
            "scratch/employees".to_owned(),
        ] {
            fs::set_permissions(
                setup.tree.root.join(path),
                fs::Permissions::from_mode(0o700),
            )
            .unwrap();
        }
        let sid = setup.oracle["employee"]["sessionId"].as_str().unwrap();
        setup
            .tree
            .write("names.out", format!("test-agent-{sid}\n").as_bytes());
        setup.tree.write(
            "ids.out",
            setup
                .rows
                .iter()
                .map(|row| row["Id"].as_str().unwrap())
                .collect::<Vec<_>>()
                .join("\n")
                .as_bytes(),
        );
        setup.tree.write(
            "inventory.out",
            setup
                .rows
                .iter()
                .map(serde_json::Value::to_string)
                .collect::<Vec<_>>()
                .join("\n")
                .as_bytes(),
        );
        setup
            .tree
            .write("writers.out", &serde_json::to_vec(&setup.rows).unwrap());
        let snapshot =
            crate::worker_validation::load_owner_config(&setup.tree.root.join("worker.json"))
                .unwrap();
        let bootstrap = EngineBootstrap::from_service(
            super::super::recovered::tests::program().as_os_str(),
            BTreeMap::new(),
            setup.tree.root.clone(),
        )
        .unwrap();
        let runtime = WorkerRuntime::new(
            InstalledWorkerEngine::new(bootstrap),
            snapshot.envelope().base(),
        );
        let fixture = Fixture::new();
        fixture.storage_facts(setup.stats);
        let mut broker = InstallingBroker::new(snapshot, runtime).unwrap();
        broker
            .gate
            .as_mut()
            .unwrap()
            .use_kernel_fixture_for_test(&fixture, &broker.storage.runtime);
        Self {
            setup,
            broker: Arc::new(broker),
            fixture,
        }
    }
    fn session(&self) -> ProfileSessionId {
        ProfileSessionId::parse(self.setup.oracle["employee"]["sessionId"].as_str().unwrap())
            .unwrap()
    }
    fn recover(&self) {
        let config = self.broker.configuration().unwrap();
        // Actual resource-only initialization, then the unchanged production
        // recovery transaction. The source has no employeeMemoryPolicies map.
        assert!(
            !reverie_contracts::device_policy::memory::resource_projection_required(
                config.configuration()
            )
        );
        let mut lease =
            StorageLease::acquire_launch(config.configuration(), &self.session()).unwrap();
        lease.prepare_storage().unwrap();
        lease.record_storage_binding().unwrap();
        lease.close().unwrap();
        self.broker.recover_laptops().unwrap();
    }
    fn preview(&self) -> crate::reservation_gate::DraftPreview {
        let employee =
            JournalId::parse(self.setup.oracle["employee"]["id"].as_str().unwrap()).unwrap();
        self.broker
            .resource_reservations()
            .unwrap()
            .unwrap()
            .draft_approved_profile(
                &employee,
                &JournalId::parse("33333333-2222-4333-8444-555555555555").unwrap(),
            )
            .unwrap()
    }
    fn tail(&self) {
        let info = fs::metadata(&self.setup.tree.root).unwrap();
        self.fixture
            .original_runtime(OriginalRuntimeTail::from_observed_data(
                [info.dev(), info.ino()],
                vec![],
            ));
    }
    fn journal(&self) -> Vec<u8> {
        fs::read(
            self.setup
                .tree
                .root
                .join("control/operations/operations.json"),
        )
        .unwrap()
    }
    fn assert_held(&self) {
        assert!(
            StorageLease::acquire_launch(
                self.broker.configuration().unwrap().configuration(),
                &self.session()
            )
            .is_err()
        );
    }
    fn assert_admission_free(&self) {
        let config = ReservationConfiguration::capture(
            self.broker.configuration().unwrap().configuration().clone(),
        );
        AdmissionLock::acquire(&config).unwrap().close().unwrap();
    }
}
impl Drop for Owned {
    fn drop(&mut self) {
        let end = Instant::now() + Duration::from_secs(5);
        for entry in self.broker.installed.lifecycle().unwrap().guard.iter() {
            if let LaptopOwner::Recovered(owner) = &entry.owner {
                owner.office._office.close(end).unwrap();
            }
        }
        self.broker.storage.runtime.close(end).unwrap();
    }
}
#[test]
fn installed_source_factory_joins_actual_recovered_owner_and_keeps_it_after_claim_close() {
    crate::test_process::owning_case!(
        installed_source_factory_joins_actual_recovered_owner_and_keeps_it_after_claim_close
    );
    let owned = Owned::new();
    owned.recover();
    owned.tail();
    let preview = owned.preview();
    let claim = owned
        .broker
        .retain_resource_draft(&preview.draft_id(), &preview.digest())
        .unwrap();
    assert_eq!(claim.operation_id(), &preview.operation_id());
    owned.assert_held();
    owned.assert_admission_free();
    assert_eq!(
        operations_v1::decode(&owned.journal())
            .unwrap()
            .operations()
            .len(),
        1
    );
    claim.close().unwrap();
    owned.assert_held();
    assert_eq!(
        owned
            .broker
            .claim_storage(&owned.session())
            .err()
            .unwrap()
            .code(),
        "WORKER_ORIGINAL_SOURCE_RETAINED"
    );
}
#[test]
fn installed_source_factory_refuses_unregistered_source_before_durable_claim() {
    crate::test_process::owning_case!(
        installed_source_factory_refuses_unregistered_source_before_durable_claim
    );
    let owned = Owned::new();
    let preview = owned.preview();
    let before = owned.journal();
    assert_eq!(
        owned
            .broker
            .retain_resource_draft(&preview.draft_id(), &preview.digest())
            .err()
            .unwrap()
            .code(),
        "RESOURCE_ORIGINAL_SOURCE_OWNER_REQUIRED"
    );
    assert_eq!(owned.journal(), before);
    owned.assert_admission_free();
}
#[test]
fn installed_source_factory_retains_actual_owner_after_durable_claim_baseline_failure() {
    crate::test_process::owning_case!(
        installed_source_factory_retains_actual_owner_after_durable_claim_baseline_failure
    );
    let owned = Owned::new();
    owned.recover();
    let preview = owned.preview();
    let error = owned
        .broker
        .retain_resource_draft(&preview.draft_id(), &preview.digest())
        .err()
        .unwrap();
    assert_eq!(error.code(), "CLAIM_OR_RESPONSE_UNCERTAIN_KEEP_ALL_CLAIMS");
    assert_eq!(
        operations_v1::decode(&owned.journal())
            .unwrap()
            .operations()
            .len(),
        1
    );
    owned.assert_held();
    assert_eq!(
        owned
            .broker
            .claim_storage(&owned.session())
            .err()
            .unwrap()
            .code(),
        "WORKER_ORIGINAL_SOURCE_RETAINED"
    );
    owned.assert_admission_free();
}
#[test]
fn installed_source_factory_restores_same_unclaimed_owner_after_observation_refusal() {
    crate::test_process::owning_case!(
        installed_source_factory_restores_same_unclaimed_owner_after_observation_refusal
    );
    let owned = Owned::new();
    owned.recover();
    let preview = owned.preview();
    let before = owned.journal();
    owned.fixture.after_storage(|| {
        Err(std::io::Error::other(
            "controlled pre-claim observation refusal",
        ))
    });
    assert!(
        owned
            .broker
            .retain_resource_draft(&preview.draft_id(), &preview.digest())
            .is_err()
    );
    assert_eq!(owned.journal(), before);
    let original = owned.broker.claim_storage(&owned.session()).unwrap();
    assert!(
        !original.newly_claimed(),
        "the exact acquired registry entry was restored"
    );
    owned.assert_held();
    owned.assert_admission_free();
}
#[test]
fn actual_different_installed_gate_is_rejected_and_its_admission_finalized() {
    crate::test_process::owning_case!(
        actual_different_installed_gate_is_rejected_and_its_admission_finalized
    );
    let mut owned = Owned::new();
    let preview = owned.preview();
    let before = owned.journal();
    let mut other = Owned::new();
    // Deliberate negative assembly of TWO genuine bootstrap owners, possible
    // only inside this module. There is no production Gate/runtime setter.
    let foreign = Arc::get_mut(&mut owned.broker).unwrap().gate.take();
    Arc::get_mut(&mut other.broker).unwrap().gate = foreign;
    let error = other
        .broker
        .retain_resource_draft(&preview.draft_id(), &preview.digest())
        .err()
        .unwrap();
    assert_eq!(error.code(), "RESOURCE_PREPARATION_BROKER_CHANGED");
    assert_eq!(owned.journal(), before);
    owned.assert_admission_free();
}
#[test]
fn cancelled_same_runtime_refuses_before_source_fence_or_durable_claim() {
    crate::test_process::owning_case!(
        cancelled_same_runtime_refuses_before_source_fence_or_durable_claim
    );
    let owned = Owned::new();
    owned.recover();
    let preview = owned.preview();
    let before = owned.journal();
    let calls = fs::read(owned.setup.tree.root.join("calls.txt")).unwrap();
    owned.broker.storage.runtime.cancellation().cancel();
    assert!(
        owned
            .broker
            .retain_resource_draft(&preview.draft_id(), &preview.digest())
            .is_err()
    );
    assert_eq!(owned.journal(), before);
    assert_eq!(
        fs::read(owned.setup.tree.root.join("calls.txt")).unwrap(),
        calls
    );
    owned.assert_held();
    owned.assert_admission_free();
}
