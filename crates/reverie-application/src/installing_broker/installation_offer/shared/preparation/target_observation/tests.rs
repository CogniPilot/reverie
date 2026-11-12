//! A genuine failed offer remains failed even with valid image-input DATA.
use super::*;
use reverie_contracts::resource_actor::{POOL_IMAGE_INPUT_FACTORY_FILES, PoolImageInputsData};
use serde_json::json;

fn input_data() -> PoolImageInputsData {
    let files: serde_json::Map<_, _> = POOL_IMAGE_INPUT_FACTORY_FILES
        .iter()
        .map(|name| {
            (
                (*name).to_owned(),
                json!({"sha256":"f".repeat(64),"bytes":1}),
            )
        })
        .collect();
    let role = |name: &str| {
        json!({
        "archive":{"path":"/tmp/fixture.tar.gz","sha256":"e".repeat(64),"bytes":1},
        "archiveConfigSHA256":"a".repeat(64),
        "imageSpec":{"Config":{"Env":[name]},
            "RootFS":{"Type":"layers","Layers":[format!("sha256:{}","b".repeat(64))]},
            "Architecture":"amd64","Os":"linux","Created":"1970-01-01T00:00:01Z"}})
    };
    PoolImageInputsData::decode(
        &serde_json::to_vec(&json!({
            "version":1,"purpose":"worker-pool-image-inputs-v1","system":"x86_64-linux",
            "source":{"path":"/tmp/source","files":files},
            "anchor":role("anchor"),"controller":role("controller")
        }))
        .unwrap(),
    )
    .unwrap()
}

#[test]
fn retained_inputs_cannot_override_original_refused_offer() {
    crate::test_process::owning_case!(retained_inputs_cannot_override_original_refused_offer);
    let (root, broker) = crate::installing_broker::recovered::tests::Tree::bootstrap_parts(
        "",
        "admission",
        512,
        4096,
    );
    let owner = BrokerInstallationOffer::unopened(
        broker,
        crate::installing_broker::installation_offer::tests::request(),
        Instant::now() + std::time::Duration::from_secs(30),
    );
    let broker = Arc::clone(&owner.broker);
    let shared = SharedInstallationOffer::retain(owner);
    let references = Arc::strong_count(&shared.owner);
    let mut failure = shared
        .preparation_view(&broker)
        .unwrap()
        .observe_target()
        .err()
        .unwrap();
    let first = failure.retained_cause();
    let calls = std::fs::read(root.join("calls.txt")).ok();
    let supplied = input_data();
    let refusal = failure
        .owner
        .qualify_observed_images(&supplied)
        .unwrap_err();
    let closed = failure.close_components();
    let after_close = failure
        .owner
        .qualify_observed_images(&supplied)
        .unwrap_err();
    let unchanged = std::fs::read(root.join("calls.txt")).ok() == calls;
    let retained = Arc::strong_count(&shared.owner) == references + 1;
    drop(failure);
    let released = Arc::strong_count(&shared.owner) == references;
    let owner = shared.try_owner().unwrap();
    let b_unchanged = !owner.failed && !owner.registration_attempted && !owner.metadata_closed;
    drop(owner);
    let end = Instant::now() + std::time::Duration::from_secs(3);
    let telemetry = broker.close_command_telemetry(end);
    let runtime = broker.storage.runtime.close(end);
    drop(shared);
    drop(broker);
    std::fs::remove_dir_all(root).unwrap();
    closed.unwrap();
    telemetry.unwrap();
    runtime.unwrap();
    assert!(Rc::ptr_eq(&first, &refusal) && Rc::ptr_eq(&first, &after_close));
    assert!(unchanged && retained && released && b_unchanged);
}
