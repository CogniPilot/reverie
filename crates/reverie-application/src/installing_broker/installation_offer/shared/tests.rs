//! Actual failed producer and native runtime. These controls grant no valid
//! origin, registration, consent or service-close witness.
use super::*;
mod preparation;

fn setup() -> (
    std::path::PathBuf,
    Arc<InstallingBroker>,
    SharedInstallationOffer,
) {
    let (root, broker) =
        super::super::super::recovered::tests::Tree::bootstrap_parts("", "admission", 512, 4096);
    let failure = broker
        .prepare_pool_installation_offer(
            super::super::tests::request(),
            Instant::now() - Duration::from_secs(1),
        )
        .err()
        .unwrap();
    let BrokerInstallationOfferFailure { owner, .. } = *failure;
    let original = Arc::clone(&owner.broker);
    (root, original, SharedInstallationOffer::retain(owner))
}
fn cleanup(
    root: std::path::PathBuf,
    broker: Arc<InstallingBroker>,
    shared: SharedInstallationOffer,
) {
    let end = Instant::now() + Duration::from_secs(3);
    let telemetry = broker.close_command_telemetry(end);
    let runtime = broker.storage.runtime.close(end);
    drop(shared);
    drop(broker);
    telemetry.unwrap();
    runtime.unwrap();
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn actual_same_offer_contention_refuses_registration_and_outer_metadata_close_without_wait() {
    crate::test_process::owning_case!(
        actual_same_offer_contention_refuses_registration_and_outer_metadata_close_without_wait
    );
    let (root, broker, shared) = setup();
    let held = shared.try_owner().unwrap();
    let registration = shared.enter_registration(&broker).err().unwrap();
    let metadata = shared.close_origin_metadata().unwrap_err();
    let original = Arc::ptr_eq(&held.broker, &broker);
    drop(held);
    let closed_metadata = shared.close_origin_metadata();
    cleanup(root, broker, shared);
    assert!(original);
    assert_eq!(
        registration.code(),
        "POOL_INSTALLATION_OFFER_BUSY_OR_POISONED"
    );
    assert_eq!(metadata.code(), "POOL_INSTALLATION_OFFER_BUSY_OR_POISONED");
    closed_metadata.unwrap();
}
#[test]
fn actual_same_offer_poison_refuses_metadata_close_and_never_recovers_a_guard() {
    crate::test_process::owning_case!(
        actual_same_offer_poison_refuses_metadata_close_and_never_recovers_a_guard
    );
    let (root, broker, shared) = setup();
    let poisoned = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _held = shared.try_owner().unwrap();
        panic!("actual offer guard poison");
    }));
    let registration = shared.enter_registration(&broker).err().unwrap();
    let metadata = shared.close_origin_metadata().unwrap_err();
    cleanup(root, broker, shared);
    assert!(poisoned.is_err());
    assert_eq!(
        registration.code(),
        "POOL_INSTALLATION_OFFER_BUSY_OR_POISONED"
    );
    assert_eq!(metadata.code(), "POOL_INSTALLATION_OFFER_BUSY_OR_POISONED");
}
