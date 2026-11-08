//! Full actual J body, using the already-owned fixed engine child fixture.
//! No Docker, company paths or reconstructed launch authority.
use super::*;
#[test]
fn actual_j_cold_eof_drives_same_native_body_finally_and_retains_live_storage() {
    crate::test_process::owning_case!(
        actual_j_cold_eof_drives_same_native_body_finally_and_retains_live_storage
    );
    let tree = crate::reservation_gate::tests::Tree::new();
    let broker = broker(&tree);
    let sid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    let (client, server) =
        crate::installing_broker::launch::tests::incoming_as(&broker, b'J', sid, false);
    let WorkerConnectionDispatch::Launch(received) =
        broker.accept_worker_connection(server).unwrap()
    else {
        panic!("actual J");
    };
    client.shutdown(std::net::Shutdown::Write).unwrap();
    let returned = crate::installing_broker::launch::service::run_launch(received);
    assert!(returned.retained.is_none(), "{:?}", returned.diagnostics);
    assert!(
        broker
            .installed
            .lifecycle()
            .unwrap()
            .guard
            .transients_empty()
    );
    let snapshot = broker.configuration().unwrap();
    assert!(
        reverie_host::worker_storage::StorageLease::acquire_launch(
            snapshot.configuration(),
            &ProfileSessionId::parse(sid).unwrap()
        )
        .is_err()
    );
    let calls = std::fs::read_to_string(tree.root.join("calls.txt")).unwrap();
    assert_eq!(
        calls
            .lines()
            .filter(|line| line.starts_with("create\0"))
            .count(),
        1
    );
    assert_eq!(
        calls
            .lines()
            .filter(|line| line.starts_with("start\0"))
            .count(),
        1
    );
    assert!(tree.root.join("cold-pane-configured").is_file());
    // The simulated LIVE laptop keeps its SAME real Box/lease. Close only its
    // fixture Office producer; this is no global/native Runtime close credit.
    let end = Instant::now() + std::time::Duration::from_secs(3);
    broker
        .recovery
        .office(&broker, &snapshot)
        .unwrap()
        .close(end)
        .unwrap();
    broker.close_command_telemetry(end).unwrap();
    assert!(broker.storage.runtime.close(end).is_err());
}
