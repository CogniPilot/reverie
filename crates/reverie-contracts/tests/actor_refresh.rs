//! A refresh preserves the complete existing configuration/binding; it cannot
//! silently become initial installation or accept a different source domain.
use reverie_contracts::{
    reservation_control::{ControlBinding, domain_digest},
    resource_actor::ActorSetupTransition,
    storage_identity::decode_ordered_metadata,
    worker_config,
};
use serde_json::{Value, json};

fn fixture(
    selected: bool,
) -> (
    Vec<u8>,
    worker_config::EffectiveWorkerConfig,
    ControlBinding,
) {
    let cases: Value =
        serde_json::from_str(include_str!("fixtures/reservation-control-python.json")).unwrap();
    let original = cases[0]["config"].as_str().unwrap();
    let selector = if selected {
        "\"resourceActorConfig\":\"/owned/control/resource-actor.json\","
    } else {
        ""
    };
    // Keep the fixture's Python surrogate and numeric spelling intact.
    let raw = format!("{{\"gid\":100,{selector}{}", &original[1..]).into_bytes();
    let config = worker_config::decode(&raw).unwrap();
    let mut marker: Value = serde_json::from_str(cases[0]["marker"].as_str().unwrap()).unwrap();
    marker["configurationDigest"] = json!(domain_digest(&config).unwrap().to_hex());
    let metadata = decode_ordered_metadata(&serde_json::to_vec(&marker).unwrap()).unwrap();
    let binding = ControlBinding::from_metadata(&metadata, &config).unwrap();
    (raw, config, binding)
}

#[test]
fn refresh_preserves_original_bytes_configuration_and_binding() {
    let (raw, config, binding) = fixture(true);
    let intent = ActorSetupTransition::prepare_refresh(&config, &raw, &binding).unwrap();
    assert!(intent.is_refresh());
    assert_eq!(intent.configuration_bytes(), raw);
    assert!(worker_config::equivalent(intent.before(), intent.after()));
    assert_eq!(
        intent.before_binding().domain(),
        intent.after_binding().domain()
    );
    assert!(ActorSetupTransition::prepare(&config, &raw, &binding).is_err());
}

#[test]
fn refresh_refuses_unselected_actor_or_changed_configuration() {
    let (raw, config, binding) = fixture(false);
    assert!(ActorSetupTransition::prepare_refresh(&config, &raw, &binding).is_err());
    let (raw, config, binding) = fixture(true);
    let changed = String::from_utf8(raw.clone())
        .unwrap()
        .replace("\"uid\": 1000", "\"uid\": 9999");
    assert!(ActorSetupTransition::prepare_refresh(&config, changed.as_bytes(), &binding).is_err());
    let (_, _, wrong_binding) = fixture(false);
    assert!(ActorSetupTransition::prepare_refresh(&config, &raw, &wrong_binding).is_err());
}
