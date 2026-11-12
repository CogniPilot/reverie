//! Real live library service; the historical read opens no native operation.
use super::*;

#[test]
fn live_service_diagnostic_read_preserves_original_listener_and_native_trace() {
    if crate::test_process::isolate_case(
        "installing_broker::service::tests::create_diagnostics::live_service_diagnostic_read_preserves_original_listener_and_native_trace",
    ) {
        return;
    }
    let (root, broker) = setup();
    let broker = Arc::new(broker);
    let service = broker
        .prepare_shared_service()
        .unwrap()
        .bind_listener()
        .unwrap();
    let before = fs::read(root.join("calls.txt")).unwrap();
    let diagnostics = service.completed_create_diagnostics();
    let no_offer = service
        .installation_offer_preparation_view()
        .unwrap()
        .is_none();
    let after = fs::read(root.join("calls.txt")).unwrap();
    let listener = root.join("control/broker.sock").exists();
    broker.request_stop();
    let closed = service.run();
    drop(broker);
    closed.unwrap();
    fs::remove_dir_all(root).unwrap();
    assert!(diagnostics.unwrap().is_empty());
    assert!(no_offer, "ordinary service has no OS installation offer");
    assert_eq!(before, after);
    assert!(listener);
}
