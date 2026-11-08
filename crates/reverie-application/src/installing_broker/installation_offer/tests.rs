//! Real installing broker/runtime; a past original deadline must refuse before
//! native origin, nonce or publication. No successful native offer is forged.
use super::*;
fn request() -> PoolInstallationRequestData {
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
fn actual_expired_owner_enters_startup_failure_whole_without_prefix_effects_or_new_deadline() {
    crate::test_process::owning_case!(
        actual_expired_owner_enters_startup_failure_whole_without_prefix_effects_or_new_deadline
    );
    let (root, broker) =
        super::super::recovered::tests::Tree::bootstrap_parts("", "admission", 512, 4096);
    let budget = broker.storage.runtime.stop_budget();
    let expired = broker
        .prepare_pool_installation_offer(request(), Instant::now() - Duration::from_secs(1))
        .err()
        .unwrap();
    let deadline = expired.owner.deadline;
    let digest = expired.owner.request.digest().clone();
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
    assert!(budget.same_runtime(&failure.owner.broker.storage.runtime));
    assert!(failure.owner.signals.is_none());
    assert!(failure.owner.listener.is_none() && failure.owner.bound_listener.is_none());
    let offer = failure.owner.installation_offer.as_mut().unwrap();
    assert!(Arc::ptr_eq(&offer.broker, &failure.owner.broker));
    assert_eq!(offer.deadline, deadline);
    assert_eq!(offer.request.digest(), &digest);
    assert!(matches!(offer.origin, Origin::Unopened));
    assert!(offer.snapshot.is_none() && offer.nonce.is_none() && offer.published.is_none());
    assert!(!offer.service_closed);
    offer.close_origin_metadata().unwrap();
    assert!(!root.join("control").exists() && !root.join("calls.txt").exists());
    failure.close_listener_component().unwrap();
    close_unstarted(&failure.owner.broker);
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
    assert!(Arc::ptr_eq(&other, &failure.owner.broker));
    assert!(failure.owner.signals.is_none());
    assert!(failure.owner.listener.is_none() && failure.owner.bound_listener.is_none());
    let offer = failure.owner.installation_offer.as_mut().unwrap();
    assert!(budget.same_runtime(&offer.broker.storage.runtime));
    assert!(!Arc::ptr_eq(&other, &offer.broker));
    offer.close_origin_metadata().unwrap();
    close_unstarted(&offer.broker);
    close_unstarted(&other);
    assert!(!root.join("control").exists() && !root.join("calls.txt").exists());
    assert!(!other_root.join("control").exists() && !other_root.join("calls.txt").exists());
    drop(failure);
    drop(other);
    std::fs::remove_dir_all(root).unwrap();
    std::fs::remove_dir_all(other_root).unwrap();
}
fn close_unstarted(broker: &Arc<InstallingBroker>) {
    let end = Instant::now() + Duration::from_secs(5);
    broker.close_command_telemetry(end).unwrap();
    broker.storage.runtime.close(end).unwrap();
}
