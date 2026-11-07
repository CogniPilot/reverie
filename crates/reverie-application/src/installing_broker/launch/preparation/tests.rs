//! Actual pre-active storage acquisition, not a modeled registry insertion.
use super::*;
use crate::{reservation_gate::tests::Tree, worker_validation::load_owner_config};
use reverie_host::{
    engine_metadata::EngineBootstrap, installed_worker_engine::InstalledWorkerEngine,
    worker_runtime::WorkerRuntime, worker_storage::StorageLease,
};
use std::{collections::BTreeMap, fs, time::Duration};
thread_local! { static BUSY: std::cell::RefCell<Option<std::sync::mpsc::SyncSender<()>>> = const { std::cell::RefCell::new(None) }; }
pub(super) fn storage_busy() {
    BUSY.with(|slot| {
        if let Some(signal) = slot.borrow_mut().take() {
            let _ = signal.send(());
        }
    });
}
pub(super) fn end() -> Instant {
    Instant::now() + Duration::from_secs(5)
}
pub(super) fn broker(tree: &Tree) -> InstallingBroker {
    let mut raw: serde_json::Value = serde_json::from_slice(&tree.raw).unwrap();
    raw.as_object_mut().unwrap().remove("resourceReservations");
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
    InstallingBroker::new(snapshot, runtime).unwrap()
}
pub(super) fn incoming<'a>(
    broker: &'a InstallingBroker,
    sid: &str,
) -> (std::os::unix::net::UnixStream, AdmittedWorkerLaunch<'a>) {
    let (client, socket) = super::super::tests::incoming_as(broker, b'J', sid, true);
    let WorkerConnectionDispatch::Launch(received) =
        broker.accept_worker_connection(socket).unwrap()
    else {
        panic!("genuine accepted J")
    };
    (client, received.begin_ordinary().unwrap())
}
fn company(tree: &Tree, sid: &str, eid: &str) {
    tree.write("company.json",&serde_json::to_vec(&serde_json::json!({"employees":[{"id":eid,"owner":null,"sessionId":sid,"desiredRunning":true}]})).unwrap());
}

#[test]
fn distinct_pre_active_abandonments_retain_actual_employee_leases_inside_the_same_connection_cap() {
    crate::test_process::owning_case!(distinct_pre_active_abandonments_retain_actual_employee_leases_inside_the_same_connection_cap);
    let tree = Tree::new();
    let broker = broker(&tree);
    let limit = broker.storage.runtime.connection_limit();
    let mut retained = Vec::new();
    for n in 1..=limit {
        let sid = format!("{n:08x}-1111-4111-8111-{n:012x}");
        let eid = format!("{n:08x}-2222-4222-8222-{n:012x}");
        company(&tree, &sid, &eid);
        let (_client, admitted) = incoming(&broker, &sid);
        let mut preparing =
            PreparingWorkerLaunch::enter(admitted).unwrap_or_else(|_| panic!("real early hold"));
        let wait = WaitObservation::capture(&preparing).unwrap();
        let claim = preparing.acquire_storage(&wait).unwrap();
        assert_eq!(claim.paths().identity(), eid);
        assert_eq!(
            broker.installed.lifecycle().unwrap().entries().count(),
            0,
            "not yet active or pending"
        );
        drop(claim); // The real registry still owns this employee's actual FD.
        drop(preparing); // Physical J close cannot retire its early held slot.
        let snapshot = broker.configuration().unwrap();
        assert!(
            StorageLease::acquire_launch(
                snapshot.configuration(),
                &ProfileSessionId::parse(&sid).unwrap()
            )
            .is_err()
        );
        retained.push((sid, eid));
    }
    let sid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    let (_client, socket) = super::super::tests::incoming_as(&broker, b'J', sid, true);
    assert!(
        broker.accept_worker_connection(socket).is_err(),
        "the next distinct session is refused by the SAME existing connection cap"
    );
    // No effect command was dispatched. This is owning-fixture teardown after
    // the assertions, not a production release/recovery contract for unknowns.
    for (sid, eid) in retained {
        company(&tree, &sid, &eid);
        broker
            .claim_storage(&ProfileSessionId::parse(&sid).unwrap())
            .unwrap()
            .release(end())
            .unwrap();
    }
    assert!(
        broker.close_command_telemetry(end()).is_err(),
        "abandoned logical holds are still negative; closed sockets do not prove completion"
    );
}

#[test]
fn actual_early_hold_moves_once_into_active_and_known_cleanup_releases_the_same_slot() {
    let tree = Tree::new();
    let broker = broker(&tree);
    tree.write("company.json", br#"{"employees":[]}"#);
    let (_client, admitted) = incoming(&broker, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    let preparing =
        PreparingWorkerLaunch::enter(admitted).unwrap_or_else(|_| panic!("real early hold"));
    let claimed = preparing
        .claim()
        .unwrap_or_else(|failure| panic!("{}", failure.cause));
    assert!(!claimed.observed.waited());
    assert!(
        claimed.preparing.hold.is_none(),
        "same hold moved, not minted again"
    );
    finish_claimed(claimed);
    let (_client, admitted) = incoming(&broker, "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff");
    admitted.close(end()).unwrap();
    broker.close_command_telemetry(end()).unwrap();
}

pub(super) fn finish_claimed(claimed: ClaimedWorkerLaunch<'_>) {
    let ClaimedWorkerLaunch {
        preparing,
        storage,
        active,
        mut lifecycle,
        observed: _,
    } = claimed;
    let mut token = active.unwrap();
    lifecycle.finalize_active(&token).unwrap();
    drop(lifecycle);
    storage.unwrap().release(end()).unwrap();
    preparing.admitted.close(end()).unwrap();
    token.release_hold(end()).unwrap();
}

#[test]
fn original_wait_releases_actual_old_employee_storage_then_claims_current_session_with_same_early_hold()
 {
    crate::test_process::owning_case!(original_wait_releases_actual_old_employee_storage_then_claims_current_session_with_same_early_hold);
    let tree = Tree::new();
    let broker = broker(&tree);
    let old = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    let next = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
    let eid = "11111111-2222-4333-8444-555555555555";
    company(&tree, old, eid);
    let previous = broker
        .claim_storage(&ProfileSessionId::parse(old).unwrap())
        .unwrap();
    let original_key = previous.paths().key();
    company(&tree, next, eid);
    let (_client, admitted) = incoming(&broker, next);
    let preparing =
        PreparingWorkerLaunch::enter(admitted).unwrap_or_else(|_| panic!("real early hold"));
    let (signal, observed) = std::sync::mpsc::sync_channel(1);
    BUSY.with(|slot| *slot.borrow_mut() = Some(signal));
    let release = std::thread::spawn(move || {
        let entered = observed.recv_timeout(Duration::from_secs(10)).is_ok();
        let closed = previous.release(end());
        (entered, closed)
    });
    let result = preparing.claim();
    let (entered, released) = release.join().unwrap();
    BUSY.with(|slot| slot.borrow_mut().take());
    assert!(
        entered,
        "actual busy result occurred before releasing original storage"
    );
    released.unwrap();
    let claimed = result.unwrap_or_else(|failure| panic!("{}", failure.cause));
    assert!(claimed.observed.waited());
    assert_eq!(
        claimed.storage.as_ref().unwrap().paths().key(),
        original_key
    );
    assert_eq!(
        claimed.storage.as_ref().unwrap().paths().session().as_str(),
        next
    );
    finish_claimed(claimed);
    broker.close_command_telemetry(end()).unwrap();
}

#[test]
fn duplicate_active_refusal_precedes_the_late_unavailable_company_read_and_keeps_early_hold() {
    let tree = Tree::new();
    let broker = broker(&tree);
    tree.write("company.json", br#"{"employees":[]}"#);
    let sid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    let (_client, first) = incoming(&broker, sid);
    let mut first = PreparingWorkerLaunch::enter(first).unwrap_or_else(|_| panic!("first hold"));
    let first_observed = WaitObservation::capture(&first).unwrap();
    let first_storage = first.acquire_storage(&first_observed).unwrap();
    let (mut first_token, first_lifecycle) = first.register(&first_observed).unwrap();
    // The actual native-phase caller releases this same mutex for long Nix
    // work. This bookkeeping control performs no such native operation.
    drop(first_lifecycle);
    let (_client, second) = incoming(&broker, sid);
    let mut second = PreparingWorkerLaunch::enter(second).unwrap_or_else(|_| panic!("second hold"));
    let observed = WaitObservation::capture(&second).unwrap();
    let storage = second.acquire_storage(&observed).unwrap();
    tree.write("company.json", b"{}");
    let error = second.register(&observed).err().unwrap();
    assert!(matches!(
        error,
        PreparationError::Gate(GateError::Refused(
            "A worker for this session is already attached"
        ))
    ));
    assert!(
        second.hold.is_some(),
        "insertion refusal leaves SAME early hold with failure owner"
    );
    tree.write("company.json", br#"{"employees":[]}"#);
    storage.release(end()).unwrap();
    let mut hold = second.hold.take().unwrap();
    second.admitted.close(end()).unwrap();
    hold.release(end()).unwrap();
    broker
        .installed
        .lifecycle()
        .unwrap()
        .finalize_active(&first_token)
        .unwrap();
    first_storage.release(end()).unwrap();
    first.admitted.close(end()).unwrap();
    first_token.release_hold(end()).unwrap();
    broker.close_command_telemetry(end()).unwrap();
}

#[test]
fn closed_connection_refuses_preparation_before_any_storage_resource_and_retains_actual_failure_owner()
 {
    let tree = Tree::new();
    let broker = broker(&tree);
    tree.write("company.json", br#"{"employees":[]}"#);
    let (_client, admitted) = incoming(&broker, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    admitted.request.close(end()).unwrap();
    let failure = PreparingWorkerLaunch::enter(admitted).err().unwrap();
    assert!(failure.storage.is_none());
    assert!(failure.active.is_none() && failure.observed.is_none() && failure.current.is_none());
    assert!(failure.preparing.hold.is_none());
    assert!(!failure.cause.to_string().is_empty());
    assert!(!tree.root.join("state/storage-locks").exists());
    failure.preparing.admitted.close(end()).unwrap();
    broker.close_command_telemetry(end()).unwrap();
}
