//! Actual refused OS prefix and counted Q. No successful native OS origin,
//! target image qualification or installed website is invented here.
use super::*;
mod qualification;

#[test]
fn equal_native_census_data_from_a_foreign_context_is_not_the_frames_origin() {
    crate::test_process::owning_case!(
        equal_native_census_data_from_a_foreign_context_is_not_the_frames_origin
    );
    let fixture = super::super::tests::Fixture::new();
    let (client, connection) = fixture.accept(
        b'Q',
        br#"{"purpose":"resource-fleet-maintenance-v1","version":1}"#,
    );
    let end = Instant::now() + Duration::from_secs(3);
    let mut frame = Frame::incoming(
        &fixture.broker,
        connection,
        WebsitePurpose::FleetPreview,
        end,
    );
    let config = fixture
        .broker
        .configuration()
        .unwrap()
        .configuration()
        .clone();
    frame.context = Some(crate::reservation_observer::NativeObserver::capture_worker(
        &fixture.broker.storage.runtime,
        config.clone(),
    ));
    let foreign = crate::reservation_observer::NativeObserver::capture_worker(
        &fixture.broker.storage.runtime,
        config,
    );
    let original = frame
        .context
        .as_ref()
        .unwrap()
        .inventory(Some(end))
        .unwrap();
    let other = foreign.inventory(Some(end)).unwrap();
    let same_data = original.equivalent(&other);
    let known = coverage::assert_inventory_origin(&frame, &original);
    let refused = coverage::assert_inventory_origin(&frame, &other);
    let foreign_close = foreign.settle_metadata_owned(end);
    let closed = frame.close(end);
    drop(client);
    drop(frame);
    foreign_close.unwrap();
    closed.unwrap();
    known.unwrap();
    assert!(same_data && refused.is_err());
}
use reverie_core::worker_wire::WorkerFrameHeader;
use reverie_host::worker_reports::AcceptedWorkerServiceConnection;
use std::{
    io::{Read, Write},
    os::unix::net::UnixStream,
};

#[test]
fn repeated_target_observe_preserves_the_same_explicitly_closeable_failed_owner() {
    crate::test_process::owning_case!(
        repeated_target_observe_preserves_the_same_explicitly_closeable_failed_owner
    );
    let (root, broker, offer) = installation_offer::tests::unopened_shared_fixture();
    let references = Arc::strong_count(&broker);
    let before = std::fs::read(root.join("calls.txt")).ok();
    let mut target = TargetAttempt::Offer(Some(offer.clone()));
    target.capture_view(&broker).unwrap();
    let first = target.observe().unwrap_err();
    let original = match &target {
        TargetAttempt::Failed(owner) => owner.retained_cause(),
        _ => panic!("actual refused origin must retain its failed owner"),
    };
    let repeated = target.observe();
    let same = matches!(&target, TargetAttempt::Failed(owner)
        if Rc::ptr_eq(&original, &owner.retained_cause()));
    let closed = target.close().is_ok();
    drop(target);
    let released = Arc::strong_count(&broker) == references;
    let after = std::fs::read(root.join("calls.txt")).ok();
    let b_unchanged = offer.preparation_view(&broker).is_ok();
    let end = Instant::now() + Duration::from_secs(3);
    let reports = broker.reports.close(end);
    let telemetry = broker.close_command_telemetry(end);
    let runtime = broker.storage.runtime.close(end);
    drop(offer);
    drop(broker);
    reports.unwrap();
    telemetry.unwrap();
    runtime.unwrap();
    std::fs::remove_dir_all(root).unwrap();
    assert_eq!(first.code(), "POOL_INSTALLATION_NATIVE_ORIGIN_RETAINED");
    assert!(repeated.is_err() && same && closed && released && b_unchanged);
    assert_eq!(before, after);
}

#[test]
fn actual_failed_origin_closes_its_q_without_poisoning_original_b_offer() {
    crate::test_process::owning_case!(
        actual_failed_origin_closes_its_q_without_poisoning_original_b_offer
    );
    let (root, broker, offer) = installation_offer::tests::unopened_shared_fixture();
    let (mut client, server) = UnixStream::pair().unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let raw = br#"{"purpose":"resource-fleet-maintenance-v1","version":1}"#;
    client
        .write_all(
            &WorkerFrameHeader::for_payload(b'Q', raw.len())
                .unwrap()
                .encode(),
        )
        .unwrap();
    client.write_all(raw).unwrap();
    let AcceptedWorkerServiceConnection::Service(connection) = broker
        .reports
        .register_worker_connection(server)
        .unwrap()
        .receive_service_for_worker(
            &broker.telemetry,
            broker.configuration().unwrap().configuration(),
        )
        .unwrap()
    else {
        panic!("actual Q record");
    };
    let before = std::fs::read(root.join("calls.txt")).ok();
    let closed = broker.handle_fleet_preview(connection, Some(offer.clone()));
    let code = closed
        .as_ref()
        .ok()
        .and_then(|closed| closed.primary_error_code());
    let finalized = closed.is_ok();
    drop(closed);
    let b_unchanged = offer.preparation_view(&broker).is_ok();
    let after = std::fs::read(root.join("calls.txt")).ok();
    let mut response = Vec::new();
    let eof = client.read_to_end(&mut response);
    drop(client);
    let end = Instant::now() + Duration::from_secs(3);
    let reports = broker.reports.close(end);
    let telemetry = broker.close_command_telemetry(end);
    let runtime = broker.storage.runtime.close(end);
    drop(offer);
    drop(broker);
    reports.unwrap();
    telemetry.unwrap();
    runtime.unwrap();
    std::fs::remove_dir_all(root).unwrap();
    assert_eq!(code, Some("POOL_INSTALLATION_NATIVE_ORIGIN_RETAINED"));
    assert!(finalized && b_unchanged && eof.is_ok() && response.is_empty());
    assert_eq!(before, after);
}
