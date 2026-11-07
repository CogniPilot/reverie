use super::tests::{broker, end, finish_claimed, incoming};
use crate::reservation_gate::tests::Tree;
mod configured;

#[test]
fn actual_prefix_metadata_finalizer_refuses_foreign_origin_and_old_same_sid_successor() {
    let tree = Tree::new();
    let broker = broker(&tree);
    tree.write("company.json", br#"{"employees":[]}"#);
    tree.write("inspect.out", b"not JSON");
    tree.write("inspect.out.status", b"7");
    let other_tree = Tree::new();
    let other = super::tests::broker(&other_tree);
    let sid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    let (_client, admitted) = incoming(&broker, sid);
    let prefix = admitted.prepare_prefix().unwrap();
    assert!(
        other
            .installed
            .lifecycle()
            .unwrap()
            .finalize_active(prefix.observed.claimed.active.as_ref().unwrap())
            .is_err()
    );
    let mut old = prefix.abort(end());
    let (_next_client, admitted) = incoming(&broker, sid);
    let mut next = admitted.prepare_prefix().unwrap();
    assert!(
        next.observed
            .claimed
            .lifecycle
            .finalize_active(old.active.as_ref().unwrap())
            .is_err()
    );
    assert_eq!(next.observed.claimed.lifecycle.entries().count(), 1);
    finish_claimed(next.observed.claimed);
    old.storage.take().unwrap().release(end()).unwrap();
    let mut token = old.active.take().unwrap();
    crate::installing_broker::lifecycle::fixture_cleanup::release_hold(&mut token, end()).unwrap();
    broker.close_command_telemetry(end()).unwrap();
    other.close_command_telemetry(end()).unwrap();
}
