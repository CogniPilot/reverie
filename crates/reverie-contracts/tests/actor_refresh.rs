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

#[test]
fn unknown_pool_pending_requires_exact_original_scope_configuration_and_all_fields() {
    use reverie_contracts::reservation_control::{PoolTransitionIntent, PoolTransitionSelection};
    use reverie_core::operations::{JournalDigest, JournalId, OperationScope};
    let (_, config, binding) = fixture(true);
    let option = reverie_contracts::worker_validation::WorkerValidationData::new(&config)
        .reservation()
        .unwrap()
        .unwrap();
    let scope = OperationScope {
        company_id: option.company().clone(),
        owner_scope_digest: option.owner_scope().clone(),
    };
    let selection = PoolTransitionSelection::new(
        JournalId::parse("aaaaaaaa-0000-4000-8000-000000000001").unwrap(),
        JournalId::parse("aaaaaaaa-0000-4000-8000-000000000002").unwrap(),
        JournalDigest::parse(&"a".repeat(64)).unwrap(),
        JournalDigest::parse(&"b".repeat(64)).unwrap(),
        JournalDigest::parse(&"c".repeat(64)).unwrap(),
        JournalDigest::parse(&worker_config::config_digest(&config).to_hex()).unwrap(),
    );
    let original = PoolTransitionIntent::capture(&selection, &scope, &binding, &config).unwrap();
    let decoded =
        PoolTransitionIntent::decode_pending(original.bytes(), &scope, &binding, &config).unwrap();
    assert_eq!(decoded.bytes(), original.bytes());
    assert_eq!(decoded.operation_id(), selection.operation_id());
    let value: Value = serde_json::from_slice(original.bytes()).unwrap();
    for key in [
        "schema",
        "state",
        "companyId",
        "ownerScopeDigest",
        "configurationDigest",
        "revisionDigest",
    ] {
        let mut changed = value.clone();
        changed[key] = json!("wrong");
        assert!(
            PoolTransitionIntent::decode_pending(
                &serde_json::to_vec(&changed).unwrap(),
                &scope,
                &binding,
                &config
            )
            .is_err(),
            "{key}"
        );
    }
    let mut changed = value;
    changed["completed"] = json!(true);
    assert!(
        PoolTransitionIntent::decode_pending(
            &serde_json::to_vec(&changed).unwrap(),
            &scope,
            &binding,
            &config
        )
        .is_err()
    );
    assert!(
        PoolTransitionIntent::decode_pending(&vec![b' '; 4097], &scope, &binding, &config).is_err()
    );
}
