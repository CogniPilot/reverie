use super::*;
fn end() -> Instant {
    Instant::now() + Duration::from_secs(20)
}
#[test]
fn retained_phone_is_same_registered_server_and_shared_close_revokes_every_alias() {
    let fixture = Fixture::new("127.0.0.1:1".parse().unwrap());
    let phone = fixture.bind("alias");
    let before = fs::symlink_metadata(fixture.root.join("alias/office.sock")).unwrap();
    let retained = fixture.service.retain_phone(&phone).unwrap();
    assert!(Arc::ptr_eq(&retained.owned, &phone.owned));
    assert_eq!(retained.session, phone.session);
    assert_eq!(fixture.service.offices.lock().unwrap().len(), 1);
    let after = fs::symlink_metadata(fixture.root.join("alias/office.sock")).unwrap();
    use std::os::unix::fs::MetadataExt;
    assert_eq!((before.dev(), before.ino()), (after.dev(), after.ino()));
    drop(phone);
    assert!(UnixStream::connect(fixture.root.join("alias/office.sock")).is_ok());
    let other = fixture.service.retain_phone(&retained).unwrap();
    fixture.service.close_phone(&retained, end()).unwrap();
    assert!(
        other
            .assert_runtime_session(&fixture.runtime, &other.session)
            .is_err()
    );
    assert!(fixture.service.retain_phone(&other).is_err());
}
#[test]
fn retained_phone_rejects_wrong_service_close_intent_and_global_stop_without_new_bind() {
    let fixture = Fixture::new("127.0.0.1:1".parse().unwrap());
    let phone = fixture.bind("alias");
    let foreign = OfficeService::from_runtime(
        &fixture.runtime,
        fixture.root.clone(),
        "127.0.0.1".parse().unwrap(),
    )
    .unwrap();
    assert!(foreign.retain_phone(&phone).is_err());
    assert!(foreign.offices.lock().unwrap().is_empty());
    phone.request_close();
    assert!(fixture.service.retain_phone(&phone).is_err());
    fixture.service.close_phone(&phone, end()).unwrap();
    let phone = fixture.bind("stopping");
    fixture.runtime.request_stop();
    assert!(fixture.service.retain_phone(&phone).is_err());
    assert_eq!(fixture.service.offices.lock().unwrap().len(), 1);
    fixture.service.close_phone(&phone, end()).unwrap();
    foreign.close(end()).unwrap();
}
