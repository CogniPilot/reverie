//! Real accepted J, lease and first inspection; only the engine is controlled.
use super::super::tests::{broker_configuration, end, incoming};
use super::*;
use crate::reservation_gate::tests::Tree;
use reverie_host::worker_storage::StorageLease;
use std::{fs, io::Read};
const SID: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const EID: &str = "11111111-2222-4333-8444-555555555555";

fn broker(tree: &Tree) -> InstallingBroker {
    let mut raw: serde_json::Value = serde_json::from_slice(&tree.raw).unwrap();
    raw.as_object_mut().unwrap().remove("resourceReservations");
    raw["budgetMode"] = serde_json::json!("admission");
    raw["memoryMiB"] = serde_json::json!(512);
    let broker = broker_configuration(tree, &raw);
    tree.write(
        "company.json",
        &serde_json::to_vec(&serde_json::json!({"employees":[{
            "id":EID,"owner":null,"sessionId":SID,"desiredRunning":true
        }]}))
        .unwrap(),
    );
    broker
}
fn inspected<'a>(
    tree: &Tree,
    broker: &'a InstallingBroker,
    running: bool,
) -> (std::os::unix::net::UnixStream, InspectedWorkerLaunch<'a>) {
    let (client, admitted) = incoming(broker, SID);
    let observed = PreparingWorkerLaunch::enter(admitted)
        .unwrap()
        .claim()
        .unwrap()
        .observe()
        .unwrap();
    tree.write(
        "inspect.out",
        &serde_json::to_vec(&serde_json::json!([{
            "Id":"a".repeat(64),"Name":format!("/{}",observed.plan.arguments().name()),
            "Config":{"Labels":{"reverie.worker":"test","reverie.session":SID,
                "reverie.worker-policy":observed.plan.arguments().policy_digest().to_hex()}},
        "State":{"Running":running,"Pid":null}
        }]))
        .unwrap(),
    );
    fs::write(
        tree.root.join("state").join(SID).join("runtime.json"),
        br#"{"exit":"original.exit"}"#,
    )
    .unwrap();
    tree.write("pane.out", b"0\n");
    (client, observed.inspect(end()).unwrap())
}
fn lease_held(broker: &InstallingBroker) -> bool {
    match StorageLease::acquire_launch(
        broker.configuration().unwrap().configuration(),
        &ProfileSessionId::parse(SID).unwrap(),
    ) {
        Ok(lease) => {
            lease.close().unwrap();
            false
        }
        Err(_) => true,
    }
}
fn no_stop(tree: &Tree) {
    let calls = fs::read_to_string(tree.root.join("calls.txt")).unwrap();
    assert!(
        !calls
            .lines()
            .any(|line| line.starts_with("stop\0") || line.starts_with("kill\0"))
    );
}
#[test]
fn actual_stopped_attach_failure_finishes_same_lease_and_hold_without_stop_dispatch() {
    crate::test_process::owning_case!(
        actual_stopped_attach_failure_finishes_same_lease_and_hold_without_stop_dispatch
    );
    let tree = Tree::new();
    let broker = broker(&tree);
    let (mut client, inspected) = inspected(&tree, &broker, false);
    let failure = inspected.classify_existing().err().unwrap();
    assert!(lease_held(&broker));
    let closed = failure.finalize_for_worker().unwrap();
    assert!(!closed.storage_retained() && !closed.completed());
    assert!(closed.primary_error().is_some());
    assert!(!lease_held(&broker));
    no_stop(&tree);
    client
        .set_read_timeout(Some(std::time::Duration::from_secs(1)))
        .unwrap();
    assert_eq!(client.read(&mut [0]).unwrap(), 0);
    broker.close_command_telemetry(end()).unwrap();
}
#[test]
fn actual_live_prefix_failure_keeps_original_storage_but_closes_its_handler() {
    crate::test_process::owning_case!(
        actual_live_prefix_failure_keeps_original_storage_but_closes_its_handler
    );
    let tree = Tree::new();
    let broker = broker(&tree);
    let (_client, inspected) = inspected(&tree, &broker, true);
    tree.write("pane.out", b"unavailable");
    let failure = inspected.classify_existing().err().unwrap();
    let closed = failure.finalize(end()).unwrap();
    assert!(closed.storage_retained() && !closed.completed());
    assert!(lease_held(&broker));
    no_stop(&tree);
    // Controlled fixture teardown; live DATA never authorized this release.
    broker
        .claim_storage(&ProfileSessionId::parse(SID).unwrap())
        .unwrap()
        .release(end())
        .unwrap();
    broker.close_command_telemetry(end()).unwrap();
}
#[test]
fn genuine_preplan_refusal_keeps_whole_original_failure_lease_and_counted_hold() {
    crate::test_process::owning_case!(
        genuine_preplan_refusal_keeps_whole_original_failure_lease_and_counted_hold
    );
    let tree = Tree::new();
    let broker = broker(&tree);
    let (_client, admitted) = incoming(&broker, SID);
    let claimed = PreparingWorkerLaunch::enter(admitted)
        .unwrap()
        .claim()
        .unwrap();
    tree.write(&format!("state/{SID}"), b"occupied original runtime name");
    let failure = claimed.observe().err().unwrap();
    assert!(failure.observation.is_none() && failure.storage.is_some());
    let retained = failure.finalize_for_worker().err().unwrap();
    assert_eq!(retained.request().session().as_str(), SID);
    assert!(retained.cleanup_error_count() > 0 && lease_held(&broker));
    no_stop(&tree);
    drop(retained);
    assert!(lease_held(&broker));
    assert!(broker.close_command_telemetry(end()).is_err());
}
#[test]
fn actual_classified_abort_never_infers_unadmitted_prefix_or_releases_its_hold() {
    crate::test_process::owning_case!(
        actual_classified_abort_never_infers_unadmitted_prefix_or_releases_its_hold
    );
    let tree = Tree::new();
    let broker = broker(&tree);
    let (_client, inspected) = inspected(&tree, &broker, true);
    let ClassifiedWorkerLaunch::Reuse(reuse) = inspected.classify_existing().unwrap() else {
        panic!("actual classified reuse")
    };
    let failure = reuse.abort();
    assert!(matches!(failure.origin, FailureOrigin::ClassifiedAbort));
    let retained = failure.finalize(end()).err().unwrap();
    assert!(lease_held(&broker) && retained.cleanup_error_count() > 0);
    no_stop(&tree);
    drop(retained);
    assert!(broker.close_command_telemetry(end()).is_err());
}
