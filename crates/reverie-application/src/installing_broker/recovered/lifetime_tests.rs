//! Actual dropped broker with a held employee flock and an executing fixed
//! Office query. Quarantine is tested as retention, never as global release.
use super::*;
use std::{io::Write, os::unix::net::UnixStream};

#[test]
fn dropped_broker_keeps_actual_employee_lease_phone_and_native_job_together() {
    crate::test_process::owning_case!(
        dropped_broker_keeps_actual_employee_lease_phone_and_native_job_together
    );
    let (root, broker) = Tree::bootstrap_parts(&format!("test-agent-{FIRST}\n"), "pool", 0, 4096);
    fs::write(root.join("company.json"), serde_json::to_vec(&serde_json::json!({"employees":[{"id":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","owner":null,"sessionId":FIRST,"desiredRunning":true}]})).unwrap()).unwrap();
    let source = broker.configuration().unwrap().configuration().clone();
    let sid = ProfileSessionId::parse(FIRST).unwrap();
    let mut prior = worker_storage::StorageLease::acquire_launch(&source, &sid).unwrap();
    prior.prepare_storage().unwrap();
    prior.record_storage_binding().unwrap();
    prior.close().unwrap();
    broker.recover_laptops().unwrap();
    fs::create_dir_all(root.join("company/console")).unwrap();
    fs::write(
        root.join("company/console/.env"),
        "REVERIE_USERNAME=fixture\nREVERIE_PASSWORD=synthetic-only\n",
    )
    .unwrap();
    fs::write(root.join("company/console/hook-secret"), "synthetic-hook\n").unwrap();
    // Even failed test setup cannot forward to a host service: the held actual
    // query completes with a known parse refusal, never a usable address.
    fs::write(root.join("server.out"), "controlled invalid server JSON").unwrap();
    fs::write(root.join("server.hold"), "same actual fixed child").unwrap();
    let mut request =
        UnixStream::connect(root.join("office").join(FIRST).join("office.sock")).unwrap();
    request
        .write_all(b"GET /api/instances HTTP/1.1\r\nHost: guest\r\nContent-Length: 0\r\n\r\n")
        .unwrap();
    let end = Instant::now() + Duration::from_secs(5);
    while !root.join("server.started").exists() && Instant::now() < end {
        std::thread::sleep(Duration::from_millis(2));
    }
    let entered = root.join("server.started").exists();
    if !entered {
        fs::write(root.join("server.release"), "always release failed setup").unwrap();
    }
    let installed = Arc::downgrade(&broker.installed);
    let storage = Arc::downgrade(&broker.storage);
    let recovery = Arc::downgrade(&broker.recovery);
    let telemetry = Arc::downgrade(&broker.telemetry);
    let reports = Arc::downgrade(&broker.reports);
    let phone_close = {
        let life = broker.installed.lifecycle().unwrap();
        let LaptopOwner::Recovered(owner) = &life.guard[0].owner else {
            panic!("genuine recovered owner")
        };
        owner
            ._office
            .close_phone(&owner._phone, Instant::now() + Duration::from_millis(50))
    };
    drop(request);
    drop(broker);
    let installed = installed.upgrade().expect("actual registry retained");
    let storage_retained = storage.upgrade().is_some();
    let recovery_retained = recovery.upgrade().is_some();
    let telemetry_retained = telemetry.upgrade().is_some();
    let reports_retained = reports.upgrade().is_some();
    let lease_busy = worker_storage::StorageLease::acquire_launch(&source, &sid).is_err();
    fs::write(root.join("server.release"), "settle the same actual child").unwrap();
    let retained_recovery = recovery.upgrade().unwrap();
    if let Some(office) = retained_recovery.office.lock().unwrap().as_ref() {
        office
            .close(Instant::now() + Duration::from_secs(5))
            .unwrap();
    }
    storage
        .upgrade()
        .unwrap()
        .runtime
        .settle_owned(Instant::now() + Duration::from_secs(5))
        .unwrap();
    let after_office_busy = worker_storage::StorageLease::acquire_launch(&source, &sid).is_err();
    assert!(entered, "actual engine child entered before cancellation");
    assert!(
        phone_close.is_err(),
        "native job still owns the request seat"
    );
    assert!(storage_retained && recovery_retained && telemetry_retained && reports_retained);
    assert!(lease_busy, "Drop cannot release the actual employee flock");
    assert!(
        after_office_busy,
        "Office/query settlement is not recovered-laptop stop or lease-release authority"
    );
    // Test-only extraction/teardown occurs AFTER the negative production
    // assertions. No RW laptop was created. Releasing these synthetic owners
    // is not a production stopped-container/capacity proof or release consumer.
    let owners = super::super::lifetime::take_abandoned(&installed);
    let entry = installed.lifecycle().unwrap().guard.remove(0);
    let LaptopOwner::Recovered(owner) = entry.owner else {
        panic!("actual retained phone and employee lease")
    };
    owner
        .storage
        .release(Instant::now() + Duration::from_secs(5))
        .unwrap();
    owners
        .1
        .runtime
        .close(Instant::now() + Duration::from_secs(5))
        .unwrap();
    worker_storage::StorageLease::acquire_launch(&source, &sid)
        .unwrap()
        .close()
        .unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn poisoned_empty_recovery_state_cannot_drop_an_actual_registered_employee_lease() {
    crate::test_process::owning_case!(
        poisoned_empty_recovery_state_cannot_drop_an_actual_registered_employee_lease
    );
    let (root, broker) = Tree::bootstrap_parts("", "pool", 0, 4096);
    fs::write(root.join("company.json"), serde_json::to_vec(&serde_json::json!({"employees":[{"id":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","owner":null,"sessionId":FIRST,"desiredRunning":true}]})).unwrap()).unwrap();
    let source = broker.configuration().unwrap().configuration().clone();
    let sid = ProfileSessionId::parse(FIRST).unwrap();
    let claim = broker.claim_storage(&sid).unwrap();
    assert!(claim.newly_claimed());
    drop(claim);
    let original = Arc::downgrade(&broker.installed);
    let installed = broker.installed.clone();
    assert!(
        std::thread::spawn(move || {
            let _held = installed.laptops.lock().unwrap();
            panic!("controlled opaque lifecycle state");
        })
        .join()
        .is_err()
    );
    drop(broker);
    let installed = original.upgrade().expect("opaque actual owner retained");
    let lease_busy = worker_storage::StorageLease::acquire_launch(&source, &sid).is_err();
    let owners = super::super::lifetime::take_abandoned(&installed);
    owners
        .1
        .runtime
        .settle_owned(Instant::now() + Duration::from_secs(5))
        .unwrap();
    owners
        .1
        .claim(&source, &sid)
        .unwrap()
        .release(Instant::now() + Duration::from_secs(5))
        .unwrap();
    owners
        .1
        .runtime
        .close(Instant::now() + Duration::from_secs(5))
        .unwrap();
    worker_storage::StorageLease::acquire_launch(&source, &sid)
        .unwrap()
        .close()
        .unwrap();
    fs::remove_dir_all(root).unwrap();
    assert!(lease_busy, "poison cannot establish empty/no-owner state");
}
