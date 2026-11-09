use super::*;

fn configured(high: u32) -> EffectiveWorkerConfig {
    let mut value: Value =
        serde_json::from_slice(&worker_config::encode_config(&configuration())).unwrap();
    value["employeeMemoryPolicies"] = json!({"enabled":"synthetic kernel policy fixture"});
    value["budgetMode"] = json!("pool");
    value["memoryMiB"] = json!(1024);
    value["laptopMemoryPolicy"] = json!({"memoryHighMiB":high,"swapMiB":0});
    worker_config::decode(&serde_json::to_vec(&value).unwrap()).unwrap()
}
fn observed(
    fixture: &Arc<Fixture>,
    label_config: &EffectiveWorkerConfig,
) -> (ObservationContext, ObservedInventory) {
    let mut worker = row(2, true);
    worker["HostConfig"]["Memory"] = json!(1073741824);
    worker["HostConfig"]["MemorySwap"] = json!(1073741824);
    worker["Config"]["Labels"] = json!({"reverie.worker":"office","reverie.session":"00000000-0000-0000-0000-000000000000","reverie.worker-policy":policy_digest(label_config).to_hex()});
    fixture.inventory(&[row(1, false), worker]);
    let context = fixture.observer().capture(label_config.clone(), None);
    let inventory = context.inventory(None).unwrap();
    (context, inventory)
}
#[test]
fn only_pool_creation_uses_verified_high_and_keeps_original_hard_binding() {
    let fixture = Fixture::new();
    let config = configured(512);
    let (context, inventory) = observed(&fixture, &config);
    assert_eq!(
        context.capacity(&inventory).unwrap().total().as_str(),
        "1073741824"
    );
    assert_eq!(
        result_code(context.pool_creation_capacity(&inventory)),
        Some("RESERVATION_POOL_NATIVE_REQUIRED")
    );
    fixture.protected_pool_facts();
    let facts = context.pool_creation_capacity(&inventory).unwrap();
    assert_eq!(facts.total().as_str(), "536870912");
    assert_eq!(facts.commitments()[0].memory().as_str(), "1073741824");
    assert_eq!(
        context.capacity(&inventory).unwrap().total().as_str(),
        "1073741824"
    );
}
#[test]
fn pool_creation_refuses_effective_policy_drift_before_soft_charge() {
    let fixture = Fixture::new();
    fixture.protected_pool_facts();
    let original = configured(512);
    let changed = configured(768);
    let (context, inventory) = observed(&fixture, &changed);
    fixture.0.lock().unwrap().effective = VecDeque::from([original, changed]);
    assert_eq!(
        result_code(context.pool_creation_capacity(&inventory)),
        Some("RESERVATION_SOURCE_POLICY")
    );
    assert_eq!(
        fixture
            .events()
            .iter()
            .filter(|event| event.starts_with("limits:"))
            .count(),
        1,
        "website only; drift refused before worker kernel limits"
    );
}
