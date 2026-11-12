//! Real installing broker/runtime; a past original deadline must refuse before
//! native origin, nonce or publication. No successful native offer is forged.
use super::*;
pub(in crate::installing_broker) fn unopened_shared_fixture() -> (
    std::path::PathBuf,
    Arc<InstallingBroker>,
    SharedInstallationOffer,
) {
    let (root, broker) =
        super::super::recovered::tests::Tree::bootstrap_parts("", "admission", 512, 4096);
    let mut owner = BrokerInstallationOffer::unopened(
        broker,
        request(),
        Instant::now() + Duration::from_secs(30),
    );
    owner.snapshot = Some(owner.broker.configuration().unwrap());
    let broker = Arc::clone(&owner.broker);
    (root, broker, SharedInstallationOffer::retain(owner))
}
pub(in crate::installing_broker) fn request() -> PoolInstallationRequestData {
    let data = serde_json::json!({"purpose":"host-pool-installation-request-v1","version":1,
        "principal":{"accountId":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            "personId":"owner","sessionEpoch":3},
        "policy":{"version":1,"purpose":reverie_contracts::worker_pool::PURPOSE,
            "deployment":"offer-fixture","instanceRoot":"/home/example/reverie",
            "engineId":"11111111-2222-4333-8444-555555555555",
            "anchorImage":format!("sha256:{}","a".repeat(64)),
            "controllerImage":format!("sha256:{}","b".repeat(64)),
            "websiteContainer":"c".repeat(64),"brokerUid":1000,"brokerGid":100,
            "memoryMaxMiB":49152,"poolTasksMax":8192,"cpuWeight":100,
            "allowedCpus":[0,1,2,3,4,5,6,7],
            "employeeMemoryHighMiB":{"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee":1024}}});
    PoolInstallationRequestData::decode(&serde_json::to_vec(&data).unwrap()).unwrap()
}
#[test]
fn expired_offer_keeps_actual_broker_before_nonce_origin_or_filesystem_effect() {
    crate::test_process::owning_case!(
        expired_offer_keeps_actual_broker_before_nonce_origin_or_filesystem_effect
    );
    let (root, broker) =
        super::super::recovered::tests::Tree::bootstrap_parts("", "admission", 512, 4096);
    let original_budget = broker.storage.runtime.stop_budget();
    let mut failure = broker
        .prepare_pool_installation_offer(request(), Instant::now() - Duration::from_secs(1))
        .err()
        .unwrap();
    assert!(matches!(
        failure.cause(),
        BrokerInstallationOfferCause::Refused("POOL_INSTALLATION_OFFER_EXPIRED_OR_CLOSED")
    ));
    assert!(failure.owner.snapshot.is_none());
    assert!(failure.owner.nonce.is_none() && failure.owner.published.is_none());
    assert!(matches!(failure.owner.origin, Origin::Unopened));
    assert!(original_budget.same_runtime(&failure.owner.broker.storage.runtime));
    let original = Arc::downgrade(&failure.owner.broker);
    failure.close_origin_metadata().unwrap();
    assert!(failure.owner.assert_current().is_err());
    drop(failure);
    let retained = original
        .upgrade()
        .expect("metadata close is not broker shutdown");
    retained
        .close_command_telemetry(Instant::now() + Duration::from_secs(5))
        .unwrap();
    retained
        .storage
        .runtime
        .close(Instant::now() + Duration::from_secs(5))
        .unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn expired_installation_startup_refuses_before_claim_and_retains_original_runtime() {
    crate::test_process::owning_case!(
        expired_installation_startup_refuses_before_claim_and_retains_original_runtime
    );
    let (root, broker) =
        super::super::recovered::tests::Tree::bootstrap_parts("", "admission", 512, 4096);
    let budget = broker.storage.runtime.stop_budget();
    let expired = broker
        .prepare_pool_installation_offer(request(), Instant::now() - Duration::from_secs(1))
        .err()
        .unwrap();
    let original = Arc::downgrade(&expired.owner.broker);
    // This is the real retained FAILED producer, not a fabricated successful
    // origin/nonce/publication. Even misuse must keep every original owner.
    let BrokerInstallationOfferFailure { owner, .. } = *expired;
    let mut failure = owner.prepare_service().err().unwrap();
    assert!(matches!(
        failure.cause(),
        BrokerStartupCause::InstallationOffer(cause)
            if matches!(cause.as_ref(), BrokerInstallationOfferCause::Refused(
                "POOL_INSTALLATION_OFFER_EXPIRED_OR_CLOSED"
            ))
    ));
    let retained = original.upgrade().expect("original runtime stays retained");
    assert!(budget.same_runtime(&retained.storage.runtime));
    assert!(
        !retained
            .service_start_claimed
            .load(std::sync::atomic::Ordering::Acquire)
    );
    failure.close_installation_origin_metadata().unwrap();
    assert!(matches!(
        failure.cause(),
        BrokerStartupCause::InstallationOffer(_)
    ));
    assert!(!root.join("control").exists() && !root.join("calls.txt").exists());
    failure.close_listener_component().unwrap();
    close_unstarted(&retained);
    drop(retained);
    drop(failure);
    assert!(
        original.upgrade().is_some(),
        "metadata close is no service-close witness"
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn actual_foreign_broker_cannot_adopt_retained_offer_or_lose_either_runtime() {
    crate::test_process::owning_case!(
        actual_foreign_broker_cannot_adopt_retained_offer_or_lose_either_runtime
    );
    let (root, broker) =
        super::super::recovered::tests::Tree::bootstrap_parts("", "admission", 512, 4096);
    let budget = broker.storage.runtime.stop_budget();
    let expired = broker
        .prepare_pool_installation_offer(request(), Instant::now() - Duration::from_secs(1))
        .err()
        .unwrap();
    let original = Arc::downgrade(&expired.owner.broker);
    let BrokerInstallationOfferFailure { owner, .. } = *expired;
    let (other_root, other) =
        super::super::recovered::tests::Tree::bootstrap_parts("", "admission", 512, 4096);
    let other = Arc::new(other);
    let mut failure = other.prepare_service_with_offer(owner).err().unwrap();
    assert!(matches!(
        failure.cause(),
        BrokerStartupCause::InstallationOffer(cause)
            if matches!(cause.as_ref(), BrokerInstallationOfferCause::Refused(
                "POOL_INSTALLATION_OFFER_FOREIGN_BROKER"
            ))
    ));
    let retained = original.upgrade().expect("original runtime stays retained");
    assert!(budget.same_runtime(&retained.storage.runtime));
    assert!(!Arc::ptr_eq(&other, &retained));
    for original in [&retained, &other] {
        assert!(
            !original
                .service_start_claimed
                .load(std::sync::atomic::Ordering::Acquire)
        );
    }
    failure.close_installation_origin_metadata().unwrap();
    assert!(matches!(
        failure.cause(),
        BrokerStartupCause::InstallationOffer(_)
    ));
    close_unstarted(&retained);
    close_unstarted(&other);
    assert!(!root.join("control").exists() && !root.join("calls.txt").exists());
    assert!(!other_root.join("control").exists() && !other_root.join("calls.txt").exists());
    drop(failure);
    drop(retained);
    drop(other);
    std::fs::remove_dir_all(root).unwrap();
    std::fs::remove_dir_all(other_root).unwrap();
}
fn close_unstarted(broker: &Arc<InstallingBroker>) {
    let end = Instant::now() + Duration::from_secs(5);
    broker.close_command_telemetry(end).unwrap();
    broker.storage.runtime.close(end).unwrap();
}
