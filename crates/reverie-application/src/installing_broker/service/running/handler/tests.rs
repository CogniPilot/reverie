//! The actual listener, registered std handler, fixed purpose read and original
//! Job join. No successful native offer or consent is substituted.
use super::*;
use std::{
    io::{Read, Write},
    os::unix::net::UnixStream,
    time::{Duration, Instant},
};

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
