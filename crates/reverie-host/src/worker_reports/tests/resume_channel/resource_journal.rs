//! Actual sockets, original native peer and real lifecycle holds only. These
//! are lower cancellation controls, not successful cookie/website authorities.
use super::*;
fn resource_channel(
    fixture: &Fixture,
    service: &Arc<WorkerReportService>,
) -> (UnixStream, WorkerActorChannel) {
    channel_with_payload(
        fixture,
        service,
        br#"{"purpose":"resource-ram-pool-v2","version":2}"#,
    )
}
#[test]
fn journal_pin_observes_only_original_socket_and_hold() {
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    let foreign = Arc::new(fixture.service());
    let (mut client, mut channel) = resource_channel(&fixture, &service);
    let original = service.records.lock().unwrap()[0].clone();
    assert!(channel.retain_resource_journal_pin(&foreign).is_err());
    let first = channel.retain_resource_journal_pin(&service).unwrap();
    let second = channel.retain_resource_journal_pin(&service).unwrap();
    first.assert_current().unwrap();
    second.assert_current().unwrap();
    assert_eq!(service.records.lock().unwrap().len(), 1);
    channel.disconnect_for_worker().unwrap();
    assert_eq!(client.read(&mut [0]).unwrap(), 0);
    assert!(first.assert_current().is_err());
    assert!(second.assert_current().is_err());
    original.require_terminal_hold().unwrap();
    channel.close_for_worker().unwrap();
    assert!(service.records.lock().unwrap().is_empty());
    assert!(first.assert_current().is_err());
    service.close(end()).unwrap();
}
#[test]
fn journal_pin_busy_original_socket_is_nonblocking_and_never_closes_it() {
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    let (client, mut channel) = resource_channel(&fixture, &service);
    let pin = channel.retain_resource_journal_pin(&service).unwrap();
    let original = service.records.lock().unwrap()[0].clone();
    let stream = original.terminal_stream().unwrap();
    let started = Instant::now();
    assert!(pin.assert_current().is_err());
    assert!(started.elapsed() < Duration::from_secs(1));
    drop(stream);
    // This lower observer can report a subsequent known read. It grants no
    // retry to an App domain's independently latched failed operation.
    pin.assert_current().unwrap();
    original.require_terminal_hold().unwrap();
    assert!(!channel.peer_ended().unwrap());
    super::super::super::record::close(client).unwrap();
    channel.close_for_worker().unwrap();
    service.close(end()).unwrap();
}
#[test]
fn consumed_peer_close_is_sticky_and_never_retries_a_descriptor_close() {
    let fixture = Fixture::new();
    let service = Arc::new(fixture.service());
    let (mut client, mut channel) = resource_channel(&fixture, &service);
    let pin = channel.retain_resource_journal_pin(&service).unwrap();
    let original = service.records.lock().unwrap()[0].clone();
    // Settle the actual sockets first so the one-shot native fault selects
    // precisely the still-owned original peer pidfd, not another descriptor.
    original
        .finish_actor_channel(&super::super::super::budget::CleanupBudget::bounded(
            &service,
            end(),
        ))
        .unwrap();
    assert_eq!(client.read(&mut [0]).unwrap(), 0);
    crate::native::test_faults::set(None, true);
    let cause = channel.disconnect_for_worker().unwrap_err();
    let cause = ResourceJournalError::from(cause);
    assert!(cause.has_unconfirmed_close());
    assert!(pin.assert_current().is_err());
    original.require_terminal_hold().unwrap();
    assert_eq!(service.records.lock().unwrap().len(), 1);
    // A second armed close fault must remain untouched by repeated cleanup.
    // Consume it on a NEW owned file afterward: no fd-number assumptions or
    // descriptor duplication are needed to prove the old close was not retried.
    crate::native::test_faults::set(None, true);
    assert!(channel.close_for_worker().is_err());
    let sentinel = fs::File::create(fixture.root.join("new-close-sentinel")).unwrap();
    assert!(
        crate::native::close(sentinel)
            .unwrap_err()
            .has_unconfirmed_close()
    );
    crate::native::test_faults::set(None, false);
    let known =
        ResourceJournalError::from(WorkerReportError::Io(std::io::Error::other("known body")));
    assert!(!known.has_unconfirmed_close());
    assert!(service.close(end()).is_err());
    assert_eq!(service.records.lock().unwrap().len(), 1);
}
