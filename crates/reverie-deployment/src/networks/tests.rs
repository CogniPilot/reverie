use super::*;

#[test]
fn retained_raw_status_allocation_counters_change_without_rewriting_the_plan() {
    let (source, mut facts) = fixture();
    for fact in &mut facts {
        fact["Status"] =
            json!({"IPAM":{"Subnets":{"192.0.2.0/24":{"IPsInUse":3,"DynamicIPsAvailable":253}}}});
    }
    let mut topology = Topology::observed(&source, facts.clone()).unwrap();
    // Format4/5/6 operations already on disk contain this original raw Status.
    for fact in &facts {
        topology
            .configurations
            .get_mut(fact["Id"].as_str().unwrap())
            .unwrap()["Status"] = fact["Status"].clone();
    }
    let original = serde_json::to_vec(&topology).unwrap();
    let restored: Topology = serde_json::from_slice(&original).unwrap();
    restored.validate().unwrap();
    for fact in &mut facts {
        fact["Status"]["IPAM"]["Subnets"]["192.0.2.0/24"] =
            json!({"IPsInUse":2,"DynamicIPsAvailable":254});
    }
    restored.require_observations(facts).unwrap();
    assert_eq!(serde_json::to_vec(&restored).unwrap(), original);
}

#[test]
fn allocation_projection_keeps_static_subnets_ipam_options_internal_and_ids_strict() {
    let (source, mut facts) = fixture();
    for fact in &mut facts {
        fact["Status"] =
            json!({"IPAM":{"Subnets":{"192.0.2.0/24":{"IPsInUse":3,"DynamicIPsAvailable":253}}}});
    }
    let topology = Topology::observed(&source, facts.clone()).unwrap();
    topology.validate().unwrap(); // Newly normalized empty counter leaves.
    for field in ["Id", "IPAM", "Options", "Internal", "Status"] {
        let mut changed = facts.clone();
        changed[1][field] = match field {
            "Id" => json!("f".repeat(64)),
            "Internal" => json!(false),
            "Status" => {
                json!({"IPAM":{"Subnets":{"198.51.100.0/24":{"IPsInUse":2,"DynamicIPsAvailable":254}}}})
            }
            _ => json!({"changed":"static configuration"}),
        };
        assert!(topology.require_observations(changed).is_err(), "{field}");
    }
}

#[test]
fn malformed_or_unknown_allocation_status_refuses_in_stored_and_fresh_shapes() {
    let (source, facts) = fixture();
    let topology = Topology::observed(&source, facts.clone()).unwrap();
    for status in [
        Value::Null,
        json!([]),
        json!({"extra":{}}),
        json!({"IPAM":{"extra":{}}}),
        json!({"IPAM":{"Subnets":[]}}),
        json!({"IPAM":{"Subnets":{"192.0.2.0/24":{"IPsInUse":1}}}}),
        json!({"IPAM":{"Subnets":{"192.0.2.0/24":{"IPsInUse":-1,"DynamicIPsAvailable":253}}}}),
        json!({"IPAM":{"Subnets":{"192.0.2.0/24":{"IPsInUse":"3","DynamicIPsAvailable":253}}}}),
        json!({"IPAM":{"Subnets":{"192.0.2.0/24":{"IPsInUse":1.5,"DynamicIPsAvailable":253}}}}),
        json!({"IPAM":{"Subnets":{"192.0.2.0/24":{"IPsInUse":3,"DynamicIPsAvailable":253,"unknown":true}}}}),
    ] {
        let mut changed = facts.clone();
        changed[1]["Status"] = status.clone();
        assert!(topology.require_observations(changed).is_err());
        let mut stored = topology.clone();
        stored.configurations.get_mut(&"2".repeat(64)).unwrap()["Status"] = status;
        assert!(stored.validate().is_err());
    }
}

fn fixture() -> (Value, Vec<Value>) {
    let mut networks = serde_json::Map::new();
    let mut facts = Vec::new();
    for index in 1..=7 {
        let key = if index == 1 {
            "bridge".to_owned()
        } else {
            format!("reverie-boxed-api-{index}")
        };
        let id = index.to_string().repeat(64);
        let aliases = if index == 1 {
            Value::Null
        } else {
            json!(["reverie"])
        };
        networks.insert(
            key.clone(),
            json!({"NetworkID":id,"Aliases":aliases,
            "IPAMConfig":{},"Links":null,"DriverOpts":null,"GwPriority":0,
            "EndpointID":"transient","IPAddress":"192.0.2.2","DNSNames":["old-container"]}),
        );
        facts.push(json!({"Id":id,"Name":key,"Driver":"bridge","Scope":"local",
            "Ingress":false,"ConfigOnly":false,"Internal":true,"Options":{},"IPAM":{},
            "Containers":{"old-container":{"IPv4Address":"192.0.2.2/24"}}}));
    }
    (
        json!({"State":{"Running":true},"NetworkSettings":{"Networks":networks}}),
        facts,
    )
}

#[test]
fn ready_claim_handover_accepts_only_recreation_of_the_default_bridge() {
    let (mut source, mut facts) = fixture();
    facts[0]["Options"]["com.docker.network.bridge.default_bridge"] = json!("true");
    facts[0]["Created"] = json!("first");
    let previous = Topology::observed(&source, facts.clone()).unwrap();

    let new_bridge = json!("a".repeat(64));
    source["NetworkSettings"]["Networks"]["bridge"]["NetworkID"] = new_bridge.clone();
    facts[0]["Id"] = new_bridge;
    facts[0]["Created"] = json!("second");
    let current = Topology::observed(&source, facts.clone()).unwrap();
    assert!(previous.claim_additions(&current).unwrap().is_empty());
    assert!(previous.require_container(&source).is_err());
    current.require_container(&source).unwrap();

    for (index, field, value) in [
        (0, "Options", json!({})),
        (0, "IPAM", json!({"Config":[{"Subnet":"198.51.100.0/24"}]})),
        (1, "Internal", json!(false)),
        (1, "Id", json!("b".repeat(64))),
    ] {
        let mut changed_facts = facts.clone();
        let mut changed_source = source.clone();
        changed_facts[index][field] = value.clone();
        if field == "Id" {
            changed_source["NetworkSettings"]["Networks"]["reverie-boxed-api-2"]["NetworkID"] =
                value;
        }
        let changed = Topology::observed(&changed_source, changed_facts).unwrap();
        assert!(previous.claim_additions(&changed).is_err(), "{field}");
    }
}

#[test]
fn preserves_seven_original_network_ids_and_aliases_without_allocated_endpoint_replay() {
    let (source, facts) = fixture();
    let topology = Topology::observed(&source, facts).unwrap();
    topology.require_container(&source).unwrap();
    let request = topology.request().unwrap();
    let endpoints = request["EndpointsConfig"].as_object().unwrap();
    assert_eq!(endpoints.len(), 7);
    assert_eq!(
        endpoints["reverie-boxed-api-7"]["NetworkID"],
        "7".repeat(64)
    );
    assert_eq!(
        endpoints["reverie-boxed-api-7"]["Aliases"],
        json!(["reverie"])
    );
    for endpoint in endpoints.values() {
        assert_eq!(endpoint.as_object().unwrap().len(), 2);
        assert!(endpoint.get("EndpointID").is_none());
        assert!(endpoint.get("IPAddress").is_none());
        assert!(endpoint.get("DNSNames").is_none());
    }
    let restored: Topology =
        serde_json::from_value(serde_json::to_value(&topology).unwrap()).unwrap();
    assert_eq!(restored, topology);
    restored.validate().unwrap(); // correlation DATA, not native-current authority
}

#[test]
fn rejects_same_name_replaced_id_foreign_alias_missing_duplicate_and_static_address() {
    let (source, facts) = fixture();
    let topology = Topology::observed(&source, facts.clone()).unwrap();
    for field in [
        "NetworkID",
        "Aliases",
        "IPAMConfig",
        "DriverOpts",
        "Links",
        "GwPriority",
    ] {
        let mut changed = source.clone();
        changed["NetworkSettings"]["Networks"]["reverie-boxed-api-2"][field] = match field {
            "NetworkID" => json!("f".repeat(64)),
            "Aliases" => json!(["foreign"]),
            "IPAMConfig" => json!({"IPv4Address":"192.0.2.22"}),
            "DriverOpts" => json!({"arbitrary":"override"}),
            "Links" => json!(["foreign"]),
            _ => json!(1),
        };
        assert!(topology.require_container(&changed).is_err(), "{field}");
    }
    let mut replaced = facts.clone();
    replaced[1]["Id"] = json!("f".repeat(64));
    assert!(Topology::observed(&source, replaced).is_err());
    let mut missing = facts.clone();
    missing.pop();
    assert!(Topology::observed(&source, missing).is_err());
    let mut duplicate = facts.clone();
    duplicate[1] = duplicate[0].clone();
    assert!(Topology::observed(&source, duplicate).is_err());
    for field in ["Name", "Driver", "Scope", "Ingress", "ConfigOnly"] {
        let mut changed = facts.clone();
        changed[1][field] = if ["Ingress", "ConfigOnly"].contains(&field) {
            json!(true)
        } else {
            json!("foreign")
        };
        assert!(Topology::observed(&source, changed).is_err(), "{field}");
    }
}

#[test]
fn created_and_stopped_containers_also_require_exact_pending_network_ids() {
    let (source, facts) = fixture();
    let topology = Topology::observed(&source, facts).unwrap();
    let mut created = source;
    created["State"]["Running"] = json!(false);
    topology.require_container(&created).unwrap();
    for endpoint in created["NetworkSettings"]["Networks"]
        .as_object_mut()
        .unwrap()
        .values_mut()
    {
        endpoint["NetworkID"] = json!("");
    }
    assert!(topology.require_container(&created).is_err());
    created["State"]["Running"] = json!(true);
    assert!(topology.require_container(&created).is_err());
    created["State"]["Running"] = json!(false);
    created["NetworkSettings"]["Networks"]
        .as_object_mut()
        .unwrap()
        .remove("reverie-boxed-api-7");
    assert!(topology.require_container(&created).is_err());
}

#[test]
fn an_extra_endpoint_is_never_hidden_by_the_original_network_projection() {
    let (mut source, facts) = fixture();
    let topology = Topology::observed(&source, facts).unwrap();
    source["NetworkSettings"]["Networks"]["extra-network"] = json!({
        "NetworkID":"8".repeat(64),"Aliases":["reverie"],"IPAMConfig":null});
    assert!(topology.require_container(&source).is_err());
}

#[test]
fn fresh_network_observation_rejects_id_aba_and_configuration_drift_but_allows_membership_changes()
{
    let (source, facts) = fixture();
    let topology = Topology::observed(&source, facts.clone()).unwrap();
    let mut joined = facts.clone();
    joined[1]["Containers"] = json!({"new-candidate":{"IPv4Address":"192.0.2.3/24"}});
    topology.require_observations(joined).unwrap();
    for field in ["Id", "Name", "Options", "IPAM", "Internal"] {
        let mut changed = facts.clone();
        changed[1][field] = match field {
            "Id" => json!("f".repeat(64)),
            "Name" => json!("reverie-boxed-api-reused-name"),
            "Internal" => json!(false),
            _ => json!({"changed":"native-configuration"}),
        };
        assert!(topology.require_observations(changed).is_err(), "{field}");
    }
}
