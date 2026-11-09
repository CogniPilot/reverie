//! Regression first: actual stopped resource plus an actual still-open phone.
use super::*;
use reverie_host::office::OfficeService;
#[test]
fn transferred_phone_must_close_before_same_stopped_storage_can_return() {
    crate::test_process::owning_case!(
        transferred_phone_must_close_before_same_stopped_storage_can_return
    );
    let (root, broker) = crate::installing_broker::recovered::tests::Tree::bootstrap_parts(
        "",
        "admission",
        512,
        4096,
    );
    let broker = Arc::new(broker);
    let session = ProfileSessionId::parse("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee").unwrap();
    std::fs::write(root.join("company.json"), serde_json::to_vec(&serde_json::json!({"employees":[{"id":"11111111-2222-4333-8444-555555555555","owner":null,"sessionId":session.as_str(),"desiredRunning":true}]})).unwrap()).unwrap();
    let source = broker.configuration().unwrap();
    let claim = broker
        .storage
        .claim(source.configuration(), &session)
        .unwrap();
    // The owned fixed child proves absence by real scoped process calls. No
    // caller flag or result substitutes the native stop/census algorithm.
    std::fs::write(root.join("control-stop-absent"), b"owned fixed fixture").unwrap();
    let end = Instant::now() + Duration::from_secs(5);
    let mut stop = claim
        .into_control_stop(source.configuration(), end)
        .ok()
        .unwrap();
    let office = OfficeService::from_runtime(
        &broker.storage.runtime,
        root.clone(),
        std::net::Ipv4Addr::LOCALHOST.into(),
    )
    .unwrap();
    let phone = office.bind(root.join("phone"), session.clone()).unwrap();
    stop._phone = Some(phone);
    let stopped = stop.stop();
    let first = stop.reclaim(end);
    let refused = first.is_err();
    let phone_close = office.close(end);
    // Preserve whichever actual owner the unchanged implementation returns;
    // regression RED must not discard a returned claim or hold an open phone.
    let returned = match first {
        Ok(claim) => Ok(claim),
        Err(failure) => {
            let (stop, _cause) = *failure;
            stop.reclaim(end)
        }
    };
    let lease_close = returned.ok().map(|claim| claim.release(end));
    let reports = broker.reports.close(end);
    let telemetry = broker.close_command_telemetry(end);
    let images = broker.close_chat_images(end);
    let native = broker.storage.runtime.close(end);
    drop(office);
    drop(broker);
    let cleanup_known = lease_close.as_ref().is_some_and(Result::is_ok)
        && phone_close.is_ok()
        && reports.is_ok()
        && telemetry.is_ok()
        && images.is_ok()
        && native.is_ok();
    if cleanup_known {
        std::fs::remove_dir_all(&root).unwrap();
    }
    stopped.unwrap();
    phone_close.unwrap();
    reports.unwrap();
    telemetry.unwrap();
    images.unwrap();
    native.unwrap();
    assert!(
        cleanup_known,
        "all actual owners must settle before verdict"
    );
    assert!(
        refused,
        "an open actual transferred phone must keep the original stopped storage retained"
    );
}
