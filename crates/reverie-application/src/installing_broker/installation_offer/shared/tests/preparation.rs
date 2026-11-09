//! Real unstarted prefix only: these controls never forge a native origin,
//! nonce, publication, successful B registration or prepared target.
use super::*;

fn unopened() -> (
    std::path::PathBuf,
    Arc<InstallingBroker>,
    SharedInstallationOffer,
) {
    let (root, broker) = crate::installing_broker::recovered::tests::Tree::bootstrap_parts(
        "",
        "admission",
        512,
        4096,
    );
    let owner = BrokerInstallationOffer::unopened(
        broker,
        crate::installing_broker::installation_offer::tests::request(),
        Instant::now() + Duration::from_secs(30),
    );
    let broker = Arc::clone(&owner.broker);
    (root, broker, SharedInstallationOffer::retain(owner))
}

#[test]
fn two_preparation_views_read_refusal_and_drop_leave_same_b_owner_unclaimed() {
    crate::test_process::owning_case!(
        two_preparation_views_read_refusal_and_drop_leave_same_b_owner_unclaimed
    );
    let (root, broker, shared) = unopened();
    let count = Arc::strong_count(&shared.owner);
    let mut first = shared.preparation_view(&broker).unwrap();
    let second = shared.preparation_view(&broker).unwrap();
    let retained = Arc::strong_count(&shared.owner) == count + 2;
    let read = first.read_current().err().unwrap();
    drop(first);
    drop(second);
    let owner = shared.try_owner().unwrap();
    let unchanged = !owner.failed
        && !owner.registration_attempted
        && !owner.metadata_closed
        && matches!(owner.origin, Origin::Unopened)
        && owner.nonce.is_none()
        && owner.published.is_none()
        && Arc::strong_count(&shared.owner) == count;
    drop(owner);
    cleanup(root, broker, shared);
    assert!(retained && unchanged);
    assert_eq!(read.code(), "POOL_INSTALLATION_OFFER_CONFIGURATION_CHANGED");
}

#[test]
fn foreign_preparation_view_does_not_poison_original_b_owner() {
    crate::test_process::owning_case!(foreign_preparation_view_does_not_poison_original_b_owner);
    let (root, broker, shared) = unopened();
    let (other_root, other_broker, other) = unopened();
    let foreign = shared.preparation_view(&other_broker).err().unwrap();
    let original = shared.preparation_view(&broker).unwrap();
    drop(original);
    let unchanged = !shared.try_owner().unwrap().failed;
    cleanup(root, broker, shared);
    cleanup(other_root, other_broker, other);
    assert!(unchanged);
    assert_eq!(foreign.code(), "POOL_INSTALLATION_OFFER_FOREIGN_BROKER");
}

#[test]
fn expired_preparation_view_and_closed_read_never_consume_registration() {
    crate::test_process::owning_case!(
        expired_preparation_view_and_closed_read_never_consume_registration
    );
    let (root, broker, shared) = setup();
    let expired = shared.preparation_view(&broker).err().unwrap();
    let expired_unclaimed = !shared.try_owner().unwrap().registration_attempted;
    cleanup(root, broker, shared);
    let (root, broker, shared) = unopened();
    let mut view = shared.preparation_view(&broker).unwrap();
    shared.close_origin_metadata().unwrap();
    let closed = view.read_current().err().unwrap();
    drop(view);
    let owner = shared.try_owner().unwrap();
    let closed_unclaimed = owner.metadata_closed && !owner.failed && !owner.registration_attempted;
    drop(owner);
    cleanup(root, broker, shared);
    assert!(expired_unclaimed && closed_unclaimed);
    assert_eq!(expired.code(), "POOL_INSTALLATION_OFFER_EXPIRED_OR_CLOSED");
    assert_eq!(closed.code(), "POOL_INSTALLATION_OFFER_EXPIRED_OR_CLOSED");
}

#[test]
fn original_policy_change_refuses_existing_view_without_consuming_b() {
    crate::test_process::owning_case!(
        original_policy_change_refuses_existing_view_without_consuming_b
    );
    let (root, broker, shared) = unopened();
    let mut view = shared.preparation_view(&broker).unwrap();
    {
        let mut owner = shared.try_owner().unwrap();
        let mut policy = owner.request.policy().clone();
        policy.cpu_weight += 1;
        let principal = owner.request.principal();
        let raw = serde_json::to_vec(&serde_json::json!({
            "purpose":"host-pool-installation-request-v1", "version":1,
            "principal":{"accountId":principal.account_id(),
                "personId":principal.person_id(), "sessionEpoch":principal.session_epoch()},
            "policy":policy
        }))
        .unwrap();
        owner.request = PoolInstallationRequestData::decode(&raw).unwrap();
    }
    let refusal = view.read_current().err().unwrap();
    drop(view);
    let owner = shared.try_owner().unwrap();
    let unchanged = !owner.failed && !owner.registration_attempted;
    drop(owner);
    cleanup(root, broker, shared);
    assert!(unchanged);
    assert_eq!(
        refusal.code(),
        "POOL_INSTALLATION_PREPARATION_BINDING_CHANGED"
    );
}

#[test]
fn genuine_snapshot_without_native_origin_cannot_return_binding_data() {
    crate::test_process::owning_case!(
        genuine_snapshot_without_native_origin_cannot_return_binding_data
    );
    let (root, broker, shared) = unopened();
    shared.try_owner().unwrap().snapshot = Some(broker.configuration().unwrap());
    let mut view = shared.preparation_view(&broker).unwrap();
    let refusal = view.read_current().err().unwrap();
    drop(view);
    let owner = shared.try_owner().unwrap();
    let unchanged =
        !owner.failed && !owner.registration_attempted && matches!(owner.origin, Origin::Unopened);
    drop(owner);
    cleanup(root, broker, shared);
    assert!(unchanged);
    assert_eq!(refusal.code(), "POOL_INSTALLATION_NATIVE_ORIGIN_RETAINED");
}
