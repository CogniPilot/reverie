use super::*;
use std::sync::mpsc;

#[test]
fn actual_source_stays_fenced_across_durable_claim_and_admission_finish_then_join() {
    crate::test_process::owning_case!(
        actual_source_stays_fenced_across_durable_claim_and_admission_finish_then_join
    );
    let owned = Owned::new();
    owned.recover();
    owned.tail();
    let ordinary = owned.broker.claim_storage(&owned.session()).unwrap();
    let preview = owned.preview();
    let journal = owned
        .setup
        .tree
        .root
        .join("control/operations/operations.json");
    let (committed, observed) = mpsc::sync_channel(1);
    let (proceed, continue_claim) = mpsc::sync_channel(1);
    let mut committed = Some(committed);
    owned.fixture.on_query(move || {
        // Synchronize the first ACTUAL native query after the real journal
        // mutation, rather than guessing an inventory query count.
        if !operations_v1::decode(&fs::read(&journal).unwrap())
            .unwrap()
            .operations()
            .is_empty()
            && let Some(signal) = committed.take()
        {
            signal.send(()).unwrap();
            continue_claim
                .recv_timeout(Duration::from_secs(10))
                .unwrap();
        }
        Ok(())
    });
    let broker = owned.broker.clone();
    let worker = std::thread::spawn(move || {
        broker.retain_resource_draft(&preview.draft_id(), &preview.digest())
    });
    let reached = observed.recv_timeout(Duration::from_secs(10)).is_ok();
    let (selected, waiting) = mpsc::sync_channel(1);
    let release = std::thread::spawn(move || {
        storage::tests::observe_next_blocking_lock(move || selected.send(()).unwrap());
        ordinary.release(Instant::now() + Duration::from_secs(5))
    });
    let selected = waiting.recv_timeout(Duration::from_secs(5)).is_ok();
    let unfinished = !release.is_finished();
    let held = StorageLease::acquire_launch(
        owned.broker.configuration().unwrap().configuration(),
        &owned.session(),
    )
    .is_err();
    let _ = proceed.send(());
    let retained = worker.join().unwrap();
    let released = release.join().unwrap();
    assert!(reached, "real durable claim preceded the held native query");
    assert!(
        selected && unfinished,
        "the original ordinary release selected the actual held registry lock"
    );
    assert!(
        held,
        "the same actual employee lease survived the entire join interval"
    );
    let claim = retained.unwrap();
    assert_eq!(
        released.err().unwrap().cause().code(),
        "WORKER_ORIGINAL_SOURCE_RETAINED"
    );
    owned.assert_admission_free();
    owned.assert_held();
    claim.close().unwrap();
    owned.assert_held();
}
