use super::*;
use reverie_contracts::{resource_config::ResourceConfiguration, resource_reload::OldPolicyStart};
use serde_json::{Value, json};
const TARGET: &str = "88888888-8888-4888-8888-888888888888";
const PEER: &str = "77777777-7777-4777-8777-777777777777";
fn resources(memory: u32) -> Value {
    json!({"budgetMode":"pool","memoryMiB":memory,"pidsLimit":128,"cpus":0,"poolMemoryMiB":4096,"poolTasksMax":1024})
}
fn config(value: &Value) -> EffectiveWorkerConfig {
    worker_config::decode(&serde_json::to_vec(value).unwrap()).unwrap()
}
#[test]
fn actual_effective_resolver_freezes_old_absent_high_and_swap_only_without_changing_r_domain() {
    for prior in [
        None,
        Some(json!({"memoryHighMiB":1024,"swapMiB":0})),
        Some(json!({"swapMiB":0})),
    ] {
        let setup = crate::reservation_gate::tests::observation_cases::Setup::new();
        let sid = ProfileSessionId::parse(setup.oracle["employee"]["sessionId"].as_str().unwrap())
            .unwrap();
        let eid =
            ProfileEmployeeId::parse(setup.oracle["employee"]["id"].as_str().unwrap()).unwrap();
        let mut before: Value = serde_json::from_slice(&setup.tree.raw).unwrap();
        before["memoryMiB"] = json!(2048);
        before["employeeMemoryPolicies"] = json!({PEER:{"memoryHighMiB":512,"swapMiB":0}});
        before["sessionResources"] = json!({PEER:resources(1536)});
        if let Some(policy) = prior {
            before["employeeMemoryPolicies"][eid.as_str()] = policy;
        }
        let original = effective_config(config(&before), &sid).unwrap();
        let mut after = before.clone();
        after["employeeResources"] = json!({eid.as_str():resources(4096)});
        after["employeeMemoryPolicies"][eid.as_str()] = json!({"memoryHighMiB":1536,"swapMiB":0});
        after["sessionResources"][TARGET] = json!({"version":2,"resources":resources(4096),"memoryPolicy":{"memoryHighMiB":1536,"swapMiB":0,"swapPoolMiB":0}});
        let frozen = OldPolicyStart::capture(
            config(&before),
            config(&after),
            sid.clone(),
            ProfileSessionId::parse(TARGET).unwrap(),
        )
        .unwrap()
        .for_employee(&eid)
        .unwrap()
        .freeze(&original)
        .unwrap();
        let old = effective_config(frozen.candidate().clone(), &sid).unwrap();
        assert_eq!(
            worker_config::encode_config(&old),
            worker_config::encode_config(&original)
        );
        assert_eq!(
            worker_config::policy_digest(&old),
            worker_config::policy_digest(&original)
        );
        assert_eq!(
            reverie_contracts::reservation_control::domain_digest(&config(&before)).unwrap(),
            reverie_contracts::reservation_control::domain_digest(frozen.candidate()).unwrap()
        );
        let target = effective_config(
            frozen.candidate().clone(),
            &ProfileSessionId::parse(TARGET).unwrap(),
        )
        .unwrap();
        let target: Value = serde_json::from_slice(&worker_config::encode_config(&target)).unwrap();
        assert_eq!(target["memoryMiB"], 4096);
        assert_eq!(target["laptopMemoryPolicy"]["memoryHighMiB"], 1536);
        let candidate: Value =
            serde_json::from_slice(&worker_config::encode_config(frozen.candidate())).unwrap();
        assert_eq!(
            candidate["employeeMemoryPolicies"][PEER],
            before["employeeMemoryPolicies"][PEER]
        );
        assert_eq!(
            candidate["sessionResources"][PEER],
            before["sessionResources"][PEER]
        );
        assert_eq!(candidate["sessionResources"][sid.as_str()]["version"], 2);
        let expected: Value =
            serde_json::from_slice(&worker_config::encode_config(&original)).unwrap();
        assert_eq!(
            candidate["sessionResources"][sid.as_str()]["memoryPolicy"],
            expected
                .get("laptopMemoryPolicy")
                .cloned()
                .unwrap_or(Value::Null)
        );
    }
}
#[test]
fn frozen_null_sid_policy_precedes_new_employee_high_without_identity_lookup() {
    let sid = ProfileSessionId::parse(TARGET).unwrap();
    let source = config(
        &json!({"budgetMode":"pool","memoryMiB":0,"pidsLimit":128,"cpus":0,"poolMemoryMiB":4096,"poolTasksMax":1024,
        "sessionResources":{TARGET:{"version":2,"resources":resources(1024),"memoryPolicy":null}},
        "employeeMemoryPolicies":{PEER:{"memoryHighMiB":2048,"swapMiB":0}},"opaque":"preserved"}),
    );
    let result = effective_config(source, &sid).unwrap();
    let value: Value = serde_json::from_slice(&worker_config::encode_config(&result)).unwrap();
    assert_eq!(value["memoryMiB"], 1024);
    assert!(value.get("laptopMemoryPolicy").is_none());
    assert_eq!(value["opaque"], "preserved");
}
#[test]
fn v2_reader_refuses_unknown_version_extra_fields_and_invalid_soft_ceiling() {
    let valid = json!({"version":2,"resources":resources(1024),"memoryPolicy":{"memoryHighMiB":512,"swapMiB":0,"swapPoolMiB":0}});
    for mutation in ["version", "extra", "missing", "high", "swap", "nested"] {
        let mut entry = valid.clone();
        match mutation {
            "version" => entry["version"] = json!(2.0),
            "extra" => entry["grant"] = json!(true),
            "missing" => {
                entry.as_object_mut().unwrap().remove("memoryPolicy");
            }
            "high" => entry["memoryPolicy"]["memoryHighMiB"] = json!(1024),
            "swap" => entry["memoryPolicy"]["swapMiB"] = json!(1),
            "nested" => entry["resources"]["unlimited"] = json!(true),
            _ => unreachable!(),
        }
        assert!(
            ResourceConfiguration::capture(config(&json!({"sessionResources":{TARGET:entry}})))
                .is_err(),
            "{mutation}"
        );
    }
}

#[test]
fn real_locked_profile_stage_emits_v2_and_preserves_explicit_sid_null_over_eid_high() {
    let setup = crate::reservation_gate::tests::observation_cases::Setup::new();
    let eid = ProfileEmployeeId::parse(setup.oracle["employee"]["id"].as_str().unwrap()).unwrap();
    let name = "control/profiles/profiles.json";
    let mut document: Value =
        serde_json::from_slice(&fs::read(setup.tree.root.join(name)).unwrap()).unwrap();
    document["profiles"][eid.as_str()]["resources"] = resources(4096);
    let before = serde_json::to_vec(&document).unwrap();
    setup.tree.write(name, &before);
    let document = profiles_v1::decode(&before).unwrap();
    let profile = &document.profiles()[&eid];
    let owners = BTreeMap::from([
        (profile.binding().current_session().clone(), eid.clone()),
        (profile.binding().target_session().clone(), eid.clone()),
    ]);
    let request = ProfileStageRequest::try_new(
        eid.clone(),
        profile.binding().clone(),
        document.revision(),
        ObservedProfileVersion::try_new(profile.version().get()).unwrap(),
        &owners,
    )
    .unwrap();
    let mut source: Value = serde_json::from_slice(&setup.tree.raw).unwrap();
    source["employeeMemoryPolicies"] = json!({eid.as_str():{"memoryHighMiB":1024,"swapMiB":0}});
    let store = ProfileStore::open(setup.tree.root.join("control/profiles")).unwrap();
    let staged = stage_config(
        &store,
        broker_resources::decode(&serde_json::to_vec(&source).unwrap()).unwrap(),
        &request,
    )
    .unwrap();
    let mut candidate: Value =
        serde_json::from_slice(&worker_config::encode_config(staged.configuration())).unwrap();
    let target = profile.binding().target_session().as_str();
    assert_eq!(candidate["sessionResources"][target]["version"], 2);
    assert_eq!(
        candidate["sessionResources"][target]["memoryPolicy"]["memoryHighMiB"],
        1024
    );
    candidate["sessionResources"][target]["memoryPolicy"] = Value::Null;
    candidate["employeeMemoryPolicies"][eid.as_str()]["memoryHighMiB"] = json!(2048);
    let restaged = stage_config(
        &store,
        broker_resources::decode(&serde_json::to_vec(&candidate).unwrap()).unwrap(),
        &request,
    )
    .unwrap();
    let effective: Value = serde_json::from_slice(&worker_config::encode_config(
        restaged.effective_configuration(),
    ))
    .unwrap();
    assert!(effective.get("laptopMemoryPolicy").is_none());
    assert_eq!(effective["memoryMiB"], 4096);
    assert_eq!(
        fs::read(setup.tree.root.join(name)).unwrap(),
        before,
        "staging is a locked read, not CAS/publication"
    );
    assert_eq!(store.snapshot().unwrap(), document);
    store.close().unwrap();
}
