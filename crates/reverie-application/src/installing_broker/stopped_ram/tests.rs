//! Real installed broker/Gate, registered storage lease and captured native
//! child. Only Gate kernel/custody facts are synthetic; no Q or launch grant.
use super::*;
use crate::{reservation_gate::tests::Tree, reservation_observer::tests::Fixture};
use reverie_contracts::worker_config;
use reverie_host::{
    engine_metadata::EngineBootstrap, installed_worker_engine::InstalledWorkerEngine,
    worker_runtime::WorkerRuntime, worker_storage::StorageLease,
};
use serde_json::{Value, json};
use std::{collections::BTreeMap, fs, os::unix::fs::MetadataExt, time::Duration};
const SID: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const EID: &str = "11111111-2222-4333-8444-555555555555";
fn end() -> Instant {
    Instant::now() + Duration::from_secs(5)
}
struct Case {
    tree: Tree,
    broker: InstallingBroker,
}
impl Case {
    fn new(present: bool, desired: bool, vacation: bool) -> Self {
        let tree = Tree::new();
        let mut raw: Value = serde_json::from_slice(&tree.raw).unwrap();
        for (name, value) in [
            ("gid", json!(fs::metadata(&tree.root).unwrap().gid())),
            ("deployment", json!("fixture")),
            ("serverContainer", json!("fixture-server")),
            ("image", json!(format!("sha256:{}", "a".repeat(64)))),
            ("budgetMode", json!("admission")),
            ("memoryMiB", json!(512)),
            ("pidsLimit", json!(128)),
            ("cpus", json!(0)),
            ("poolMemoryMiB", json!(4096)),
            ("poolTasksMax", json!(1024)),
            ("employeeResources", json!({})),
            ("sessionResources", json!({})),
        ] {
            raw[name] = value;
        }
        tree.write("worker.json", &serde_json::to_vec(&raw).unwrap());
        let marker_config = worker_config::decode(&serde_json::to_vec(&raw).unwrap()).unwrap();
        let binding = reverie_contracts::reservation_control::domain_digest(&marker_config)
            .unwrap()
            .to_hex();
        let marker_path = tree.root.join("state/resource-reservation-control.json");
        let mut marker: Value = serde_json::from_slice(&fs::read(&marker_path).unwrap()).unwrap();
        marker["configurationDigest"] = json!(binding);
        tree.write(
            "state/resource-reservation-control.json",
            &serde_json::to_vec(&marker).unwrap(),
        );
        tree.write("company.json",&serde_json::to_vec(&json!({"employees":[{"id":EID,"sessionId":SID,"sessionGeneration":7,"owner":null,"desiredRunning":desired,"onVacation":vacation}]})).unwrap());
        tree.write("ps.out", b"");
        tree.write("stopped-ram-control", b"fixed owned fixture");
        let snapshot =
            crate::worker_validation::load_owner_config(&tree.root.join("worker.json")).unwrap();
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
        let kernel = Fixture::new();
        let mut broker = InstallingBroker::new(snapshot, runtime).unwrap();
        broker
            .gate
            .as_mut()
            .unwrap()
            .use_kernel_fixture_for_test(&kernel, &broker.storage.runtime);
        let mut row = json!({"Id":"c".repeat(64),"Name":format!("/fixture-agent-{SID}"),"Image":format!("sha256:{}","a".repeat(64)),"Config":{"Labels":{"reverie.worker":"fixture","reverie.session":SID,"reverie.employee":EID,"reverie.worker-policy":worker_config::policy_digest(&marker_config).to_hex()}},"State":{"Running":false,"Pid":0},"Mounts":[],"HostConfig":{"Memory":536870912u64,"MemorySwap":536870912u64,"PidsLimit":128,"NanoCpus":0}});
        tree.write("ram-row.out", &serde_json::to_vec(&row).unwrap());
        row["State"] = json!({"Running":false,"Pid":0,"Status":"exited","StartedAt":"2026-11-07T00:00:00Z","Paused":false,"Restarting":false,"Dead":false});
        tree.write("ram-stopped.out", &serde_json::to_vec(&row).unwrap());
        tree.write(
            "ram-ids.out",
            if present {
                b"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\n"
            } else {
                b""
            },
        );
        Self { tree, broker }
    }
    fn employee(&self) -> ProfileEmployeeId {
        ProfileEmployeeId::parse(EID).unwrap()
    }
    fn held(&self) -> bool {
        match StorageLease::acquire_launch(
            self.broker.configuration().unwrap().configuration(),
            &ProfileSessionId::parse(SID).unwrap(),
        ) {
            Err(_) => true,
            Ok(lease) => {
                lease.close().unwrap();
                false
            }
        }
    }
    fn assert_no_effect(&self) {
        let trace = fs::read_to_string(self.tree.root.join("calls.txt")).unwrap_or_default();
        assert!(
            trace
                .lines()
                .all(|line| line.starts_with("ps\0") || line.starts_with("inspect\0")),
            "{trace}"
        );
    }
}
impl Drop for Case {
    fn drop(&mut self) {
        self.broker.storage.runtime.close(end()).unwrap();
    }
}

#[test]
fn actual_installed_readside_preserves_off_vacation_and_same_held_claim_without_waking() {
    crate::test_process::owning_case!(
        actual_installed_readside_preserves_off_vacation_and_same_held_claim_without_waking
    );
    for (present, desired, vacation) in [
        (true, true, false),
        (false, false, false),
        (true, true, true),
    ] {
        let case = Case::new(present, desired, vacation);
        let company = fs::read(case.tree.root.join("company.json")).unwrap();
        let configuration = fs::read(case.tree.root.join("worker.json")).unwrap();
        let journal = fs::read(case.tree.root.join("control/operations/operations.json")).unwrap();
        let mut entered = case
            .broker
            .prepare_stopped_ram_source(&case.employee())
            .unwrap();
        match entered.report() {
            StoppedRamReport::PresentStopped {
                current,
                start_allowed,
                declaration,
                ..
            } => {
                assert!(present);
                assert_eq!(current.session().as_str(), SID);
                assert_eq!(current.generation().decimal(), "7");
                assert_eq!(start_allowed, desired && !vacation);
                assert_eq!(declaration.memory().as_str(), "536870912");
            }
            StoppedRamReport::Absent {
                current,
                start_allowed,
                ..
            } => {
                assert!(!present);
                assert_eq!(current.identity().as_str(), EID);
                assert_eq!(start_allowed, desired && !vacation);
            }
        }
        assert!(case.held());
        entered.assert_current().unwrap();
        let claim = entered.abort_unclaimed(end()).unwrap();
        assert!(
            case.held(),
            "restoring Direct custody did not physically release its lease"
        );
        assert_eq!(claim.paths().session().as_str(), SID);
        assert_eq!(
            fs::read(case.tree.root.join("company.json")).unwrap(),
            company
        );
        assert_eq!(
            fs::read(case.tree.root.join("worker.json")).unwrap(),
            configuration
        );
        assert_eq!(
            fs::read(case.tree.root.join("control/operations/operations.json")).unwrap(),
            journal
        );
        claim.release(end()).unwrap();
        assert!(!case.held());
        case.assert_no_effect();
    }
}
#[test]
fn actual_installed_metadata_generation_drift_refuses_but_known_abort_retains_same_lease() {
    crate::test_process::owning_case!(
        actual_installed_metadata_generation_drift_refuses_but_known_abort_retains_same_lease
    );
    let case = Case::new(false, false, false);
    let mut entered = case
        .broker
        .prepare_stopped_ram_source(&case.employee())
        .unwrap();
    let mut company: Value =
        serde_json::from_slice(&fs::read(case.tree.root.join("company.json")).unwrap()).unwrap();
    company["employees"][0]["sessionGeneration"] = json!(8);
    case.tree
        .write("company.json", &serde_json::to_vec(&company).unwrap());
    assert_eq!(
        entered.assert_current().unwrap_err().code(),
        "RAM_STOPPED_EMPLOYEE_CHANGED"
    );
    assert!(case.held());
    let claim = entered.abort_unclaimed(end()).unwrap();
    assert!(case.held());
    claim.release(end()).unwrap();
    case.assert_no_effect();
}
#[test]
fn actual_installed_declaration_failure_can_abort_known_unclaimed_frame_without_losing_primary() {
    crate::test_process::owning_case!(
        actual_installed_declaration_failure_can_abort_known_unclaimed_frame_without_losing_primary
    );
    let case = Case::new(true, false, false);
    let mut row: Value =
        serde_json::from_slice(&fs::read(case.tree.root.join("ram-row.out")).unwrap()).unwrap();
    row["HostConfig"]["Memory"] = json!(0);
    case.tree
        .write("ram-row.out", &serde_json::to_vec(&row).unwrap());
    let failure = case
        .broker
        .prepare_stopped_ram_source(&case.employee())
        .err()
        .expect("no finite native declaration");
    let primary = failure.code();
    assert!(case.held());
    let (claim, reported) = failure
        .abort_unclaimed(end())
        .unwrap_or_else(|failure| panic!("{failure:?}"))
        .into_parts();
    assert_eq!(reported.code(), primary);
    let claim = claim.expect("actual original claim returned after known native settlement");
    assert!(case.held());
    claim.release(end()).unwrap();
    case.assert_no_effect();
}
