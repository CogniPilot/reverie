use super::*;
#[test]
fn checked_finalizer_failure_keeps_complete_and_pending_and_consumes_all_local_barriers() {
    if crate::test_process::isolate_cold_namespace(
        "worker_laptop::tests::cold_prepare::finalizer::checked_finalizer_failure_keeps_complete_and_pending_and_consumes_all_local_barriers",
    ) {
        return;
    }
    let mut fixture = Fixture::new("created-cold");
    policy(&mut fixture, "clear");
    employee(&fixture);
    let workflow = network(&fixture);
    let target = seed_target(&workflow);
    fs::write(target.join("disposable"), b"owned").unwrap();
    crate::worker_storage::fail_cold_finalizer_for_owned_test();
    assert!(matches!(
        fixture
            .runtime()
            .prepare_laptop_cold_temporary(&workflow, end())
            .unwrap(),
        ColdPreparation::Retained
    ));
    assert_eq!(
        workflow.failure().unwrap().unwrap().code(),
        "WORKER_COLD_EFFECT_UNCONFIRMED"
    );
    let record = workflow.record.try_lock().unwrap();
    let paths = record.resources().plan.storage();
    assert!(paths.root().join("cold-tmp-cleanup.pending.json").is_file());
    assert_eq!(
        fs::read_dir(paths.root())
            .unwrap()
            .filter(|entry| entry
                .as_ref()
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("cold-tmp-complete-"))
            .count(),
        1
    );
    assert_eq!(fs::read_dir(&target).unwrap().count(), 0);
    // Injection reports failure AFTER the real close. Every remaining local
    // finalizer still runs; the ACTUAL canonical barrier must now be acquirable.
    let barrier = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(
            paths
                .home()
                .join(".local/state/reverie/leases/barrier.lock"),
        )
        .unwrap();
    barrier.try_lock().unwrap();
    crate::native::close(barrier).unwrap();
    let source = record.resources().plan.source().clone();
    let session = paths.session().clone();
    drop(record);
    let contender = fixture
        .runtime()
        .resolve_storage(&source, &session)
        .unwrap();
    assert!(
        contender.acquire().is_err(),
        "original employee resource lease remains retained"
    );
    assert!(
        fixture
            .runtime()
            .prepare_laptop_cold_temporary(&workflow, end())
            .is_err()
    );
    assert!(!fixture.root.join("created-laptop").exists());
}
