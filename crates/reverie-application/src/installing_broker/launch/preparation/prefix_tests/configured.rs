//! Full installed-Gate entry/wait/abort through the actual accepted J factory.
//! Fixed empty owned engine inventory; no snapshot swap or kernel-result stub.
use super::super::*;
use super::*;
use crate::{installing_broker::lifecycle::fixture_cleanup, worker_validation::load_owner_config};
use reverie_contracts::reservation_engine::ReservationConfiguration;
use reverie_host::{
    engine_metadata::EngineBootstrap,
    installed_worker_engine::InstalledWorkerEngine,
    reservation_control::AdmissionLock,
    worker_runtime::WorkerRuntime,
    worker_storage::{StorageError, StorageFault, StorageLease},
};
use std::{collections::BTreeMap, time::Duration};
const OLD: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const NEXT: &str = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const EID: &str = "11111111-2222-4333-8444-555555555555";
fn company(tree: &Tree, session: &str) {
    tree.write("company.json", &serde_json::to_vec(&serde_json::json!({"employees":[{"id":EID,"owner":null,"sessionId":session,"desiredRunning":true}]})).unwrap());
}
fn configured(tree: &Tree) -> InstallingBroker {
    tree.write("ids.out", b"");
    let snapshot = load_owner_config(&tree.root.join("worker.json")).unwrap();
    let bootstrap = EngineBootstrap::from_service(
        crate::installing_broker::recovered::tests::program().as_os_str(),
        BTreeMap::new(),
        tree.root.clone(),
    )
    .unwrap();
    let runtime = WorkerRuntime::new(
        InstalledWorkerEngine::new(bootstrap),
        snapshot.envelope().base(),
    );
    InstallingBroker::new(snapshot, runtime).unwrap()
}
fn data(broker: &InstallingBroker) -> ReservationConfiguration {
    ReservationConfiguration::capture(broker.configuration().unwrap().configuration().clone())
}
fn common_busy(config: &ReservationConfiguration) -> bool {
    match AdmissionLock::acquire(config) {
        Err(error) => error.code() == "RESERVATION_ADMISSION_LOCK_BUSY",
        Ok(mut lock) => {
            lock.close().unwrap();
            false
        }
    }
}
fn physical_busy(error: &StorageError) -> bool {
    match error {
        StorageError::Refused(StorageFault::LeaseBusy) => true,
        StorageError::PartialEffects(error) => physical_busy(error),
        _ => false,
    }
}
fn lease_busy(snapshot: &ValidatedWorkerSnapshot, session: &str) -> bool {
    match StorageLease::acquire_launch(
        snapshot.configuration(),
        &ProfileSessionId::parse(session).unwrap(),
    ) {
        Err(error) => physical_busy(&error),
        Ok(lease) => {
            lease.close().unwrap();
            false
        }
    }
}
fn stopped(tree: &Tree, session: &str) {
    tree.write("inspect.out", &serde_json::to_vec(&serde_json::json!([{"Config":{"Labels":{"reverie.worker":"test","reverie.session":session}},"State":{"Running":false}}])).unwrap());
}
fn fixture_close(mut failure: Box<PreparationFailure<'_>>) {
    assert!(failure.cleanup.is_empty());
    failure.storage.take().unwrap().release(end()).unwrap();
    let mut token = failure.active.take().unwrap();
    fixture_cleanup::release_hold(&mut token, end()).unwrap();
}

#[test]
fn actual_installed_gate_prefix_holds_common_flock_and_abort_closes_admission_without_releasing_storage_or_hold()
 {
    crate::test_process::owning_case!(actual_installed_gate_prefix_holds_common_flock_and_abort_closes_admission_without_releasing_storage_or_hold);
    let tree = Tree::new();
    company(&tree, OLD);
    stopped(&tree, OLD);
    let broker = configured(&tree);
    let (_client, admitted) = incoming(&broker, OLD);
    assert!(admitted.admission.is_some());
    let prefix = admitted.prepare_prefix().unwrap();
    assert!(
        prefix
            .observed
            .claimed
            .preparing
            .admitted
            .admission
            .is_some()
    );
    assert!(common_busy(&data(&broker)));
    assert!(lease_busy(&broker.configuration().unwrap(), OLD));
    let failure = prefix.abort(end());
    assert!(failure.cleanup.is_empty());
    let mut common = AdmissionLock::acquire(&data(&broker)).unwrap();
    common.close().unwrap();
    assert!(lease_busy(&broker.configuration().unwrap(), OLD));
    assert!(
        broker.close_command_telemetry(end()).is_err(),
        "SAME original logical hold remains counted"
    );
    fixture_close(failure);
}

#[test]
fn actual_old_eid_wait_releases_common_admission_before_old_lease_then_reacquires_after_current_binding_checks()
 {
    crate::test_process::owning_case!(actual_old_eid_wait_releases_common_admission_before_old_lease_then_reacquires_after_current_binding_checks);
    wait_case(false);
}
#[test]
fn actual_installed_gate_wait_refuses_changed_employee_binding_before_new_admission_or_storage() {
    crate::test_process::owning_case!(
        actual_installed_gate_wait_refuses_changed_employee_binding_before_new_admission_or_storage
    );
    wait_case(true);
}
fn wait_case(change_binding: bool) {
    let tree = Tree::new();
    company(&tree, OLD);
    stopped(&tree, NEXT);
    let broker = configured(&tree);
    let previous = broker
        .claim_storage(&ProfileSessionId::parse(OLD).unwrap())
        .unwrap();
    let key = previous.paths().key();
    company(&tree, NEXT);
    let (_client, admitted) = incoming(&broker, NEXT);
    assert!(admitted.admission.is_some());
    let snapshot = broker.configuration().unwrap();
    let config = data(&broker);
    let company_path = tree.root.join("company.json");
    let (pause, reached, resume) = crate::test_process::pause_point();
    super::super::tests::BUSY_PAUSE.with(|slot| *slot.borrow_mut() = Some(pause));
    let worker = std::thread::spawn(move || {
        let entered = reached.recv_timeout(Duration::from_secs(10)).is_ok();
        // Both probes precede the actual previous.release call. Always collect
        // finalizers and resume/join before assertions, including setup failure.
        let common = AdmissionLock::acquire(&config).and_then(|mut lock| lock.close());
        let still_busy = lease_busy(&snapshot, NEXT);
        let changed = if change_binding {
            std::fs::write(company_path, serde_json::to_vec(&serde_json::json!({"employees":[{"id":EID,"owner":null,"sessionId":"cccccccc-dddd-4eee-8fff-111111111111","desiredRunning":true}]})).unwrap())
        } else {
            Ok(())
        };
        let released = previous.release(end());
        let _ = resume.send(());
        (entered, common, still_busy, changed, released)
    });
    let result = admitted.prepare_prefix();
    let (entered, common, busy_before_release, changed, released) = worker.join().unwrap();
    super::super::tests::BUSY_PAUSE.with(|slot| slot.borrow_mut().take());
    assert!(entered);
    common.unwrap();
    assert!(busy_before_release);
    changed.unwrap();
    released.unwrap();
    if change_binding {
        changed_binding_refused(result.err().unwrap(), &broker);
        return;
    }
    let prefix = result.unwrap();
    assert!(prefix.observed.claimed.observed.waited());
    assert_eq!(
        prefix
            .observed
            .claimed
            .storage
            .as_ref()
            .unwrap()
            .paths()
            .key(),
        key
    );
    assert_eq!(prefix.request().session().as_str(), NEXT);
    assert!(
        prefix
            .observed
            .claimed
            .preparing
            .admitted
            .admission
            .is_some()
    );
    assert!(
        common_busy(&data(&broker)),
        "genuine common admission reacquired after old lease release"
    );
    fixture_close(prefix.abort(end()));
    broker.close_command_telemetry(end()).unwrap();
}
fn changed_binding_refused(mut failure: Box<PreparationFailure<'_>>, broker: &InstallingBroker) {
    assert!(matches!(
        failure.cause,
        PreparationError::Refused("Laptop launch changed while waiting for previous data")
    ));
    assert!(failure.storage.is_none() && failure.active.is_none());
    assert!(failure.preparing.admitted.admission.is_none());
    let mut common = AdmissionLock::acquire(&data(broker)).unwrap();
    common.close().unwrap();
    assert!(failure.close_transport(end()).is_empty());
    // This fixture proved previous.release completed and refusal occurred
    // before a second acquisition. Not a generic storage=None release rule.
    failure
        .preparing
        .hold
        .take()
        .unwrap()
        .release(end())
        .unwrap();
    broker.close_command_telemetry(end()).unwrap();
}
