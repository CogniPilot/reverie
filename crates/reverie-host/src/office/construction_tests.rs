use super::*;
fn bind(fixture: &Fixture) -> OfficeBindFailure {
    fixture
        .service
        .bind_retained(
            fixture.root.join("phone"),
            ProfileSessionId::parse(SID).unwrap(),
        )
        .err()
        .expect("actual selected construction failure")
}
#[test]
fn known_runtime_and_spawn_failure_return_no_unsettled_constructor() {
    for point in [test_hooks::Failure::Runtime, test_hooks::Failure::Spawn] {
        let fixture = Fixture::new("127.0.0.1:9".parse().unwrap());
        test_hooks::set(point);
        let (_, owner) = bind(&fixture).into_parts();
        assert!(owner.is_none());
        assert!(fixture.service.offices.lock().unwrap().is_empty());
        assert!(!fixture.root.join("phone/office.sock").exists());
    }
}
#[test]
fn real_stop_after_spawn_returns_exact_unpublished_constructor_and_checked_close() {
    let fixture = Fixture::new("127.0.0.1:9".parse().unwrap());
    test_hooks::set(test_hooks::Failure::StopAfterSpawn);
    let (error, owner) = bind(&fixture).into_parts();
    assert!(matches!(error, OfficeError::Closed));
    let owner = owner.expect("actual server was constructed before real stop");
    assert_eq!(fixture.service.offices.lock().unwrap().len(), 1);
    fixture
        .service
        .close_construction(&owner, Instant::now() + Duration::from_secs(2))
        .unwrap();
    assert!(fixture.service.offices.lock().unwrap().is_empty());
    assert!(!fixture.root.join("phone/office.sock").exists());
    // A Company sweep cannot turn the genuine already-closed token into a
    // missing-resource refusal or cause another FD close attempt.
    fixture
        .service
        .close(Instant::now() + Duration::from_secs(2))
        .unwrap();
    fixture
        .service
        .close_construction(&owner, Instant::now() + Duration::from_secs(2))
        .unwrap();
}
#[test]
fn unconfirmed_leaf_or_consumed_close_failure_returns_same_retained_owner() {
    for point in [test_hooks::Failure::AfterAnchor, test_hooks::Failure::Spawn] {
        let mut fixture = Fixture::new("127.0.0.1:9".parse().unwrap());
        test_hooks::set(point);
        if point == test_hooks::Failure::Spawn {
            crate::native::test_faults::set(None, true);
        }
        let (error, owner) = bind(&fixture).into_parts();
        assert!(matches!(error, OfficeError::Finalization { .. }));
        let owner = owner.expect("actual retained failure");
        assert!(
            fixture
                .service
                .close_construction(&owner, Instant::now() + Duration::from_secs(2))
                .is_err()
        );
        assert!(
            fixture
                .service
                .close_construction(&owner, Instant::now() + Duration::from_secs(2))
                .is_err()
        );
        assert_eq!(fixture.service.offices.lock().unwrap().len(), 1);
        fixture.close_ok = false;
    }
}
#[test]
fn construction_from_another_company_cannot_close_even_with_same_runtime_origin() {
    let fixture = Fixture::new("127.0.0.1:9".parse().unwrap());
    let other = OfficeService::from_runtime(
        &fixture.runtime,
        fixture.root.clone(),
        "127.0.0.1".parse().unwrap(),
    )
    .unwrap();
    test_hooks::set(test_hooks::Failure::StopAfterSpawn);
    let (_, owner) = bind(&fixture).into_parts();
    let owner = owner.unwrap();
    assert!(matches!(
        other.close_construction(&owner, Instant::now() + Duration::from_secs(2)),
        Err(OfficeError::Refused)
    ));
    fixture
        .service
        .close_construction(&owner, Instant::now() + Duration::from_secs(2))
        .unwrap();
    other
        .close(Instant::now() + Duration::from_secs(2))
        .unwrap();
}
