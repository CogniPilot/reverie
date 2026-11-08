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
        .storage
        .runtime
        .close(Instant::now() + Duration::from_secs(5))
        .unwrap();
    std::fs::remove_dir_all(root).unwrap();
}
