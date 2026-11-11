//! Actual listener/handler/Record. There is no OS offer or successful native
//! website proof; missing setup must refuse and close only its original Q.
use super::*;

fn exercise(
    service: &BrokerService,
    broker: &Arc<InstallingBroker>,
    root: &std::path::Path,
    hello: &[u8],
) -> (Option<String>, bool) {
    let mut client = UnixStream::connect(root.join("control/broker.sock")).unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    client
        .write_all(
            &reverie_core::worker_wire::WorkerFrameHeader::for_payload(b'Q', hello.len())
                .unwrap()
                .encode(),
        )
        .unwrap();
    client.write_all(hello).unwrap();
    service.poll_handler().unwrap();
    let mut raw = [0; 5];
    let response = if client.read_exact(&mut raw).is_ok() {
        let header = reverie_core::worker_wire::WorkerFrameHeader::decode(raw);
        if header.kind() == b'E' && header.payload_length() <= 1000 {
            let mut body = vec![0; header.payload_length() as usize];
            client.read_exact(&mut body).unwrap();
            Some(String::from_utf8(body).unwrap())
        } else {
            None
        }
    } else {
        None
    };
    nix::unistd::close(client).unwrap();
    let end = Instant::now() + Duration::from_secs(1);
    let joined = loop {
        match broker.reports.collect_worker_handlers() {
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
    (response, joined)
}

#[test]
fn actual_fleet_missing_offer_refuses_setup_and_leaves_ram_routing_unchanged() {
    crate::test_process::owning_case!(
        actual_fleet_missing_offer_refuses_setup_and_leaves_ram_routing_unchanged
    );
    let (root, broker) = crate::installing_broker::recovered::tests::Tree::bootstrap_parts(
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
    let before = std::fs::read(root.join("calls.txt")).unwrap();
    let fleet = exercise(
        &service,
        &broker,
        &root,
        br#"{"purpose":"resource-fleet-maintenance-v1","version":1,"replyVersion":2}"#,
    );
    let ram = exercise(
        &service,
        &broker,
        &root,
        br#"{"purpose":"resource-ram-pool-v2","version":2}"#,
    );
    let old_web = exercise(
        &service,
        &broker,
        &root,
        br#"{"purpose":"resource-fleet-maintenance-v1","version":1}"#,
    );
    let no_native_change = std::fs::read(root.join("calls.txt")).unwrap() == before;
    let active = !broker.storage.runtime.cancellation().is_cancelled();
    broker.request_stop();
    let closed = service.run();
    drop(broker);
    closed.unwrap();
    std::fs::remove_dir_all(root).unwrap();
    assert_eq!(fleet.0.as_deref(), Some("FLEET_PREVIEW_SETUP_REQUIRED"));
    assert_eq!(
        old_web.0.as_deref(),
        Some("FLEET_REPLY_CODEC_UPGRADE_REQUIRED")
    );
    assert!(old_web.1);
    assert!(fleet.1 && ram.1 && ram.0.is_none() && no_native_change && active);
}
