use super::*;
#[test]
fn actual_queued_launch_rechecks_fence_after_original_admission_wait() {
    crate::test_process::owning_case!(
        actual_queued_launch_rechecks_fence_after_original_admission_wait
    );
    let (setup, _fixture, gate) = prepared();
    let selected = selection(&gate);
    let sid = session(&setup);
    let (pause, reached, resume) = crate::test_process::pause_point();
    let (notice, waiting) = std::sync::mpsc::sync_channel(1);
    *gate.inner.entry_wait_notice.lock().unwrap() = Some(notice);
    gate.pause_next_entry_capture(pause);
    let publisher_gate = ReservationGate {
        inner: gate.inner.clone(),
    };
    let publisher = std::thread::spawn(move || {
        publisher_gate
            .establish_pool_transition(&selected, AdmissionBounds::default())
            .map(|fence| fence.operation_id().clone())
            .map_err(|failure| failure.cause().code())
    });
    // Keep all setup outcomes until both actual admitted threads are released
    // and joined. A setup/assertion failure cannot strand the paused owner.
    let captured = reached.recv_timeout(Duration::from_secs(5));
    let waiting_gate = ReservationGate {
        inner: gate.inner.clone(),
    };
    let waiter = std::thread::spawn(move || {
        match waiting_gate.admit_ordinary_launch(
            &sid,
            AdmissionBounds {
                operation: None,
                entry: Some(Instant::now() + Duration::from_secs(5)),
            },
        ) {
            Ok(admission) => admission.close().map_err(|error| error.code()),
            Err(error) => Err(error.code()),
        }
    });
    let observed_wait = waiting.recv_timeout(Duration::from_secs(5));
    let released = resume.send(());
    let published = publisher.join();
    let refused = waiter.join();
    assert!(
        captured.is_ok(),
        "actual entry capture must precede the queued launch"
    );
    assert!(
        observed_wait.is_ok(),
        "actual condvar wait branch must be observed"
    );
    assert!(released.is_ok());
    assert!(published.unwrap().is_ok());
    assert_eq!(
        refused.unwrap(),
        Err("POOL_TRANSITION_REQUIRES_RECONCILIATION")
    );
    assert!(pending(&setup.tree).exists());
}
