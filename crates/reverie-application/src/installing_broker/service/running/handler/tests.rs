//! The actual listener, registered std handler, fixed purpose read and original
//! Job join. No successful native offer or consent is substituted.
use super::*;
use std::{
    io::{Read, Write},
    os::unix::net::UnixStream,
    time::{Duration, Instant},
};

fn refused_control(
    service: &BrokerService,
    root: &std::path::Path,
    raw: &[u8],
    expected: &str,
) -> (bool, bool, bool) {
    let mut client = UnixStream::connect(root.join("control/broker.sock")).unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    client
        .write_all(
            &reverie_core::worker_wire::WorkerFrameHeader::for_payload(b'C', raw.len())
                .unwrap()
                .encode(),
        )
        .unwrap();
    client.write_all(raw).unwrap();
    let dispatched = service.poll_handler().is_ok();
    let mut header = [0; 5];
    let read = client.read_exact(&mut header);
    let header = reverie_core::worker_wire::WorkerFrameHeader::decode(header);
    let mut body = vec![0; header.payload_length() as usize];
    let body_read = client.read_exact(&mut body);
    let refused = read.is_ok()
        && body_read.is_ok()
        && header.kind() == b'E'
        && String::from_utf8_lossy(&body).contains(expected);
    nix::unistd::close(client).unwrap();
    let end = Instant::now() + Duration::from_millis(100);
    let joined = loop {
        match service
            .startup
            .owner
            .broker
            .reports
            .collect_worker_handlers()
        {
            Ok(reverie_host::worker_reports::WorkerHandlersProgress::Pending)
                if Instant::now() < end =>
            {
                std::thread::yield_now()
            }
            result => {
                break matches!(
                    result,
                    Ok(reverie_host::worker_reports::WorkerHandlersProgress::Settled)
                );
            }
        }
    };
    (dispatched, refused, joined)
}

#[test]
fn known_control_refusals_join_before_exhausting_original_service_capacity() {
    crate::test_process::owning_case!(
        known_control_refusals_join_before_exhausting_original_service_capacity
    );
    let (root, broker) = super::super::super::super::recovered::tests::Tree::bootstrap_parts(
        "",
        "admission",
        512,
        4096,
    );
    let broker = Arc::new(broker);
    let service = broker
        .prepare_shared_service()
        .unwrap()
        .bind_listener()
        .unwrap();
    let limit = broker.storage.runtime.connection_limit();
    let observations = (0..=limit)
        .map(|_| {
            refused_control(
                &service,
                &root,
                br#"{"action":"unsupported-known"}"#,
                "WORKER_CONTROL_UNSUPPORTED",
            )
        })
        .collect::<Vec<_>>();
    let still_running = !broker.storage.runtime.cancellation().is_cancelled()
        && broker.storage.runtime.stop_deadline().is_none();
    broker.request_stop();
    let shutdown = service.run();
    drop(broker);
    // The baseline retains real handlers: reconcile and join all of them during
    // actual shutdown before checking whether ordinary serving released them.
    shutdown.unwrap();
    std::fs::remove_dir_all(root).unwrap();
    assert!(
        still_running,
        "ordinary refusals must not request global stop"
    );
    assert!(
        observations
            .iter()
            .all(|&(dispatched, refused, joined)| dispatched && refused && joined),
        "each known refusal must close its own record and original handler: {observations:?}"
    );
}

#[test]
fn known_readonly_census_failures_join_before_exhausting_original_service_capacity() {
    crate::test_process::owning_case!(
        known_readonly_census_failures_join_before_exhausting_original_service_capacity
    );
    let (root, broker) = super::super::super::super::recovered::tests::Tree::bootstrap_parts(
        "",
        "admission",
        512,
        4096,
    );
    let broker = Arc::new(broker);
    let service = broker
        .prepare_shared_service()
        .unwrap()
        .bind_listener()
        .unwrap();
    let before = std::fs::read_to_string(root.join("calls.txt")).unwrap();
    // Startup already consumed the real empty census. Each subsequent status
    // owns a successful native query whose malformed output is a known refusal.
    std::fs::write(root.join("names.out"), b"foreign-container\n").unwrap();
    let limit = broker.storage.runtime.connection_limit();
    let observations = (0..=limit)
        .map(|_| {
            refused_control(
                &service,
                &root,
                br#"{"action":"status"}"#,
                "WORKER_CONTROL_STOP_CENSUS",
            )
        })
        .collect::<Vec<_>>();
    let calls = std::fs::read_to_string(root.join("calls.txt")).unwrap();
    let still_running = !broker.storage.runtime.cancellation().is_cancelled()
        && broker.storage.runtime.stop_deadline().is_none();
    broker.request_stop();
    let shutdown = service.run();
    drop(broker);
    // The feature-RED still settles every original handler before the verdict.
    shutdown.unwrap();
    std::fs::remove_dir_all(root).unwrap();
    assert!(still_running);
    assert!(
        observations
            .iter()
            .all(|&(dispatched, refused, joined)| dispatched && refused && joined),
        "known readonly Native refusal must close its own record: {observations:?}"
    );
    let census_calls = |text: &str| {
        text.lines()
            .filter(|line| line.starts_with("ps\0--filter\0"))
            .count()
    };
    assert_eq!(
        census_calls(&calls) - census_calls(&before),
        limit + 1,
        "one original query per request, no replay"
    );
    assert!(
        calls
            .lines()
            .all(|line| !line.starts_with("stop\0") && !line.starts_with("rm\0"))
    );
}

#[test]
fn actual_serving_b_without_original_offer_closes_record_and_joins_original_handler() {
    crate::test_process::owning_case!(
        actual_serving_b_without_original_offer_closes_record_and_joins_original_handler
    );
    let (root, broker) = super::super::super::super::recovered::tests::Tree::bootstrap_parts(
        "",
        "admission",
        512,
        4096,
    );
    let broker = Arc::new(broker);
    let service = broker
        .prepare_shared_service()
        .unwrap()
        .bind_listener()
        .unwrap();
    let mut client = UnixStream::connect(root.join("control/broker.sock")).unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let hello = br#"{"purpose":"host-pool-registration-v1","version":1}"#;
    client
        .write_all(
            &reverie_core::worker_wire::WorkerFrameHeader::for_payload(b'B', hello.len())
                .unwrap()
                .encode(),
        )
        .unwrap();
    client.write_all(hello).unwrap();
    let dispatched = service.poll_handler();
    let read = client.read(&mut [0; 1]);
    let end = Instant::now() + Duration::from_secs(3);
    let joined = loop {
        match broker.reports.collect_worker_handlers() {
            Ok(reverie_host::worker_reports::WorkerHandlersProgress::Pending)
                if Instant::now() < end =>
            {
                std::thread::yield_now()
            }
            result => break result,
        }
    };
    let client_close = nix::unistd::close(client);
    broker.request_stop();
    let shutdown = service.run();
    drop(broker);
    // Attempt actual close/join before verdict, including a regression RED.
    dispatched.unwrap();
    client_close.unwrap();
    shutdown.unwrap();
    std::fs::remove_dir_all(root).unwrap();
    assert_eq!(read.unwrap(), 0);
    assert!(matches!(
        joined.unwrap(),
        reverie_host::worker_reports::WorkerHandlersProgress::Settled
    ));
}
