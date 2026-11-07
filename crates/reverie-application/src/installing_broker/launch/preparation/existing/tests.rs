use super::super::tests::{broker, end, finish_claimed, incoming};
use super::*;
use crate::reservation_gate::tests::Tree;

pub(super) fn observe<'a>(broker: &'a InstallingBroker) -> ObservedWorkerLaunch<'a> {
    let (_client, admitted) = incoming(broker, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    PreparingWorkerLaunch::enter(admitted)
        .unwrap_or_else(|_| panic!("actual early hold"))
        .claim()
        .unwrap_or_else(|e| panic!("{}", e.cause))
        .observe()
        .unwrap_or_else(|e| panic!("{}", e.cause))
}

#[test]
fn actual_first_inspect_consumes_the_same_locked_plan_and_ignores_optional_nonzero_bytes() {
    let tree = Tree::new();
    let broker = broker(&tree);
    tree.write("company.json", br#"{"employees":[]}"#);
    tree.write("inspect.out", b"not-json");
    tree.write("inspect.out.status", b"7");
    let inspected = observe(&broker)
        .inspect(end())
        .unwrap_or_else(|e| panic!("{}", e.cause));
    assert!(inspected.previous.is_none());
    let trace = std::fs::read_to_string(tree.root.join("calls.txt")).unwrap();
    assert!(
        trace
            .lines()
            .last()
            .unwrap()
            .starts_with("inspect\0test-agent-")
    );
    assert!(
        broker.installed.laptops.try_lock().is_err(),
        "SAME lifecycle still held"
    );
    finish_claimed(inspected.observed.claimed);
    broker.close_command_telemetry(end()).unwrap();
}

#[test]
fn stopped_first_inspect_requires_owned_labels_before_state_and_keeps_all_resources_on_refusal() {
    let tree = Tree::new();
    let broker = broker(&tree);
    tree.write("company.json", br#"{"employees":[]}"#);
    tree.write(
        "inspect.out",
        br#"[{"Config":{"Labels":{"reverie.worker":"foreign"}},"State":{"Running":false}}]"#,
    );
    let failure = observe(&broker).inspect(end()).err().unwrap();
    assert!(matches!(
        failure.cause,
        PreparationError::Existing(reverie_contracts::broker_laptop::LaptopReadError::Ownership)
    ));
    assert!(failure.storage.is_some() && failure.active.is_some() && failure.current.is_some());
    assert!(
        failure.preparing.hold.is_none(),
        "actual hold stays in original active token"
    );
    let lifecycle = broker.installed.lifecycle().unwrap();
    let claimed = ClaimedWorkerLaunch {
        preparing: failure.preparing,
        storage: failure.storage,
        active: failure.active,
        observed: failure.observed.unwrap(),
        lifecycle,
    };
    finish_claimed(claimed);
    broker.close_command_telemetry(end()).unwrap();
}

#[test]
fn stopped_owned_first_inspect_accepts_missing_id_and_defers_running_policy() {
    let tree = Tree::new();
    let broker = broker(&tree);
    tree.write("company.json", br#"{"employees":[]}"#);
    tree.write("inspect.out", br#"[{"Config":{"Labels":{"reverie.worker":"test","reverie.session":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"}},"State":{"Running":[]}},42]"#);
    let inspected = observe(&broker)
        .inspect(end())
        .unwrap_or_else(|e| panic!("{}", e.cause));
    let previous = inspected.previous.as_ref().unwrap();
    assert!(!previous.data().running().unwrap());
    assert!(previous.data().canonical_id().is_none());
    finish_claimed(inspected.observed.claimed);
    broker.close_command_telemetry(end()).unwrap();
}
