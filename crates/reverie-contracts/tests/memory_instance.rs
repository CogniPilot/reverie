use reverie_contracts::memory_instance::MemoryInstance;
fn points(value: &serde_json::Value) -> Vec<u32> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_u64().unwrap() as u32)
        .collect()
}
#[test]
fn actual_instance_schema_and_initial_model_codepoints_survive_unchanged() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/memory-instance-python.json")).unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let result = MemoryInstance::decode_json(case["raw"].as_str().unwrap());
        assert_eq!(
            result.is_ok(),
            case["accepted"].as_bool().unwrap(),
            "{}",
            case["raw"]
        );
        if let Ok(instance) = result {
            assert_eq!(instance.id().as_str(), case["id"].as_str().unwrap());
            assert_eq!(
                instance.agent_name().codepoints(),
                points(&case["agentName"])
            );
            assert_eq!(
                instance.owner_name().codepoints(),
                points(&case["ownerName"])
            );
            assert_eq!(instance.persona().codepoints(), points(&case["persona"]));
            assert_eq!(instance.role().codepoints(), points(&case["role"]));
            assert_eq!(instance.kind().as_str(), case["kind"].as_str().unwrap());
            assert_eq!(
                instance.shared_room_tone().as_str(),
                case["tone"].as_str().unwrap()
            );
            assert_eq!(
                instance.employee_id().map(|id| id.as_str()),
                case["employeeId"].as_str()
            );
            assert_eq!(
                instance.initial_model().unwrap().json_text().codepoints(),
                points(&case["initialModelPoints"])
            );
        }
    }
}
