//! Genuine startup recovery supplies the original Office producer and the
//! employee lease; these are never synthesized lifecycle registrations.
use super::*;
use reverie_host::worker_storage::StorageLease;
use std::{io::Write, os::unix::net::UnixStream};

fn recover(tree: &Tree, broker: &InstallingBroker) -> Arc<reverie_host::office::OfficeService> {
    employee(tree);
    let source = broker.configuration().unwrap();
    let mut prior = StorageLease::acquire_launch(
        source.configuration(),
        &ProfileSessionId::parse(SID).unwrap(),
    )
    .unwrap();
    prior.prepare_storage().unwrap();
    prior.record_storage_binding().unwrap();
    prior.close().unwrap();
    tree.write(
        "recovery-names.out",
        format!("test-agent-{SID}\n").as_bytes(),
    );
    assert_eq!(broker.recover_laptops().unwrap().registered(), 1);
    tree.write("ps.out", b"");
    assert!(
        tree.root
            .join("office")
            .join(SID)
            .join("office.sock")
            .exists()
    );
    let life = broker.installed.lifecycle().unwrap();
    let crate::installing_broker::recovered::LaptopOwner::Recovered(owner) = &life.guard[0].owner
    else {
        panic!("genuine recovered Office owner");
    };
    owner.office._office.clone()
}
fn close_office(office: &reverie_host::office::OfficeService) {
    office.close(end()).unwrap();
}
fn lease_is_free(source: &EffectiveWorkerConfig) -> bool {
    StorageLease::acquire_migration(source, &ProfileSessionId::parse(SID).unwrap())
        .map(|lease| lease.close().unwrap())
        .is_ok()
}
#[test]
fn completed_reuse_closes_actual_recovered_phone_before_employee_lease_is_consumed() {
    crate::test_process::owning_case!(
        completed_reuse_closes_actual_recovered_phone_before_employee_lease_is_consumed
    );
    let tree = Tree::new();
    let broker = broker(&tree);
    let office = recover(&tree, &broker);
    let provider = Provider::new(&tree);
    let reuse = reusable(&tree, &broker);
    let exit = receipt(&reuse);
    let source = reuse.inspected.observed.current.configuration().clone();
    let owner = reuse.prepare_viewer().unwrap().close_allocation().unwrap();
    enable(&tree, provider.child.id());
    fs::create_dir_all(exit.parent().unwrap()).unwrap();
    fs::write(exit, b"0").unwrap();
    assert!(owner.finalize_for_worker().unwrap().completed());
    assert!(broker.installed.lifecycle().unwrap().guard.is_empty());
    assert!(UnixStream::connect(tree.root.join("office").join(SID).join("office.sock")).is_err());
    assert!(lease_is_free(&source));
    close_office(&office);
    broker.close_command_telemetry(end()).unwrap();
}
fn held_query(tree: &Tree) -> UnixStream {
    fs::create_dir_all(tree.root.join("company/console")).unwrap();
    tree.write(
        "company/console/.env",
        b"REVERIE_USERNAME=fixture\nREVERIE_PASSWORD=synthetic-only\n",
    );
    tree.write("company/console/hook-secret", b"synthetic-hook\n");
    tree.write("server.hold", b"retain same actual native query");
    let mut request =
        UnixStream::connect(tree.root.join("office").join(SID).join("office.sock")).unwrap();
    request
        .write_all(b"GET /api/instances HTTP/1.1\r\nHost: guest\r\nContent-Length: 0\r\n\r\n")
        .unwrap();
    wait_file(&tree.root.join("server.started"));
    request
}
#[test]
fn actual_recovered_phone_query_uncertainty_keeps_registration_employee_lease_and_handler_hold() {
    crate::test_process::owning_case!(
        actual_recovered_phone_query_uncertainty_keeps_registration_employee_lease_and_handler_hold
    );
    let tree = Tree::new();
    let broker = broker(&tree);
    let office = recover(&tree, &broker);
    let provider = Provider::new(&tree);
    let reuse = reusable(&tree, &broker);
    let exit = receipt(&reuse);
    let source = reuse.inspected.observed.current.configuration().clone();
    let owner = reuse.prepare_viewer().unwrap().close_allocation().unwrap();
    enable(&tree, provider.child.id());
    fs::create_dir_all(exit.parent().unwrap()).unwrap();
    fs::write(exit, b"0").unwrap();
    let (pause, reached, resume) = crate::test_process::pause_point();
    super::super::super::finalizer::REGISTRATION_PAUSE
        .with(|slot| *slot.borrow_mut() = Some(pause));
    let (result, request) = std::thread::scope(|scope| {
        let fixture = &tree;
        let query = scope.spawn(move || {
            reached.recv_timeout(Duration::from_secs(5)).unwrap();
            assert!(fixture.root.join("provider-exited").is_file());
            let request = held_query(fixture);
            resume.send(()).unwrap();
            request
        });
        let result = owner.finalize_for_worker();
        (result, query.join().unwrap())
    });
    // Release the exact owned fixture query before assertions or teardown.
    tree.write("server.release", b"settle original query");
    drop(request);
    close_office(&office);
    let failure = result.expect_err("actual Office close remains unknown");
    assert!(failure.cleanup_error_count() > 0);
    assert_eq!(broker.installed.lifecycle().unwrap().guard.len(), 1);
    assert!(!lease_is_free(&source));
    assert!(broker.close_command_telemetry(end()).is_err());
    drop(failure);
}

#[test]
fn failed_actual_stop_preserves_original_recovered_phone_and_registration() {
    crate::test_process::owning_case!(
        failed_actual_stop_preserves_original_recovered_phone_and_registration
    );
    let tree = Tree::new();
    let broker = broker(&tree);
    let office = recover(&tree, &broker);
    let provider = Provider::new(&tree);
    let reuse = reusable(&tree, &broker);
    let exit = receipt(&reuse);
    let source = reuse.inspected.observed.current.configuration().clone();
    let owner = reuse.prepare_viewer().unwrap().close_allocation().unwrap();
    enable(&tree, provider.child.id());
    tree.write(
        "finalizer-stop-error",
        b"actual fixed stop subprocess exits seven",
    );
    fs::create_dir_all(exit.parent().unwrap()).unwrap();
    fs::write(exit, b"0").unwrap();
    let result = owner.finalize_for_worker();
    let registration_count = broker.installed.lifecycle().unwrap().guard.len();
    let phone_present = tree
        .root
        .join("office")
        .join(SID)
        .join("office.sock")
        .exists();
    let lease_free = lease_is_free(&source);
    // Always settle the genuine Office fixture before any assertion can panic.
    close_office(&office);
    assert!(result.is_err());
    assert_eq!(
        registration_count, 1,
        "failed stop cannot remove a shared registration"
    );
    assert!(
        phone_present,
        "failed stop cannot close a shared recovered phone"
    );
    assert!(!lease_free);
    assert!(!tree.root.join("provider-exited").exists());
    assert!(broker.close_command_telemetry(end()).is_err());
}

#[test]
fn stopped_without_receipt_requires_fresh_scope_before_shared_office_or_storage_cleanup() {
    crate::test_process::owning_case!(
        stopped_without_receipt_requires_fresh_scope_before_shared_office_or_storage_cleanup
    );
    let tree = Tree::new();
    let broker = broker(&tree);
    let office = recover(&tree, &broker);
    let provider = Provider::new(&tree);
    let reuse = reusable(&tree, &broker);
    let source = reuse.inspected.observed.current.configuration().clone();
    let owner = reuse.prepare_viewer().unwrap().close_allocation().unwrap();
    enable(&tree, provider.child.id());
    tree.write(
        "release-provider",
        b"actual fixture target stops independently",
    );
    wait_file(&tree.root.join("provider-exited"));
    tree.write("stopped-provider", "a".repeat(64).as_bytes());
    tree.write(
        "state/resource-reservation-control.json",
        b"late prior control requires reconciliation",
    );
    let failure = owner
        .finalize_for_worker()
        .expect_err("fresh ordinary scope must refuse");
    let original_still_registered = broker.installed.lifecycle().unwrap().guard.len() == 1;
    let phone_present = tree
        .root
        .join("office")
        .join(SID)
        .join("office.sock")
        .exists();
    close_office(&office);
    assert!(
        failure
            .to_string()
            .contains("RESERVATION_INSTALL_REQUIRES_RECONCILIATION")
    );
    assert!(original_still_registered && phone_present);
    assert!(!lease_is_free(&source));
    assert!(broker.close_command_telemetry(end()).is_err());
}

#[test]
fn worker_phone_grace_starts_after_scope_wait_with_live_phone_connection() {
    crate::test_process::owning_case!(
        worker_phone_grace_starts_after_scope_wait_with_live_phone_connection
    );
    let tree = Tree::new();
    let broker = broker(&tree);
    let office = recover(&tree, &broker);
    let provider = Provider::new(&tree);
    let reuse = reusable(&tree, &broker);
    let exit = receipt(&reuse);
    let source = reuse.inspected.observed.current.configuration().clone();
    let owner = reuse.prepare_viewer().unwrap().close_allocation().unwrap();
    enable(&tree, provider.child.id());
    fs::create_dir_all(exit.parent().unwrap()).unwrap();
    fs::write(exit, b"0").unwrap();
    let (pause, reached, resume) = crate::test_process::pause_point();
    super::super::super::finalizer::REGISTRATION_PAUSE
        .with(|slot| *slot.borrow_mut() = Some(pause));
    let (result, request) = std::thread::scope(|scope| {
        let fixture = &tree;
        let query = scope.spawn(move || {
            reached.recv_timeout(Duration::from_secs(5)).unwrap();
            // Exhaust an incorrectly early two-second phone budget while the
            // actual finalizer is still before lifecycle/phone acquisition.
            std::thread::sleep(Duration::from_millis(2_100));
            let mut request =
                UnixStream::connect(fixture.root.join("office").join(SID).join("office.sock"))
                    .unwrap();
            // A real incomplete request keeps the phone connection alive but
            // cannot start an upstream native job. Such a job must separately
            // retain its seat and would correctly make phone close unknown.
            request
                .write_all(b"GET /api/instances HTTP/1.1\r\nHost: fixture\r\n")
                .unwrap();
            resume.send(()).unwrap();
            request
        });
        let result = owner.finalize_for_worker();
        (result, query.join().unwrap())
    });
    drop(request);
    close_office(&office);
    let closed = result.expect("worker phone grace starts at its actual close phase");
    assert!(closed.completed());
    assert!(!closed.storage_retained());
    assert!(broker.installed.lifecycle().unwrap().guard.is_empty());
    assert!(lease_is_free(&source));
    broker.close_command_telemetry(end()).unwrap();
}
