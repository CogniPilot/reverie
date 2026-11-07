use reverie_contracts::{
    storage_identity::decode_metadata,
    worker_intent::{self, IntentDataError},
};
use reverie_core::ids::ProfileSessionId;

#[test]
fn actual_broker_allowed_keeps_first_match_truthiness_and_detached_rules() {
    let vectors: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/worker-intent-python.json")).unwrap();
    let session = ProfileSessionId::parse(vectors["session"].as_str().unwrap()).unwrap();
    for case in vectors["cases"].as_array().unwrap() {
        let result =
            worker_intent::current_allowed(case["company"].as_str().unwrap().as_bytes(), &session)
                .and_then(|selected| match selected {
                    Some(value) => Ok(value),
                    None => worker_intent::detached_allowed(
                        &decode_metadata(case["plan"].as_str().unwrap().as_bytes()).unwrap(),
                        &session,
                    ),
                });
        if let Some(expected) = case["result"].as_bool() {
            assert_eq!(result, Ok(expected), "{}", case["name"]);
        } else {
            let expected = match case["error"].as_str().unwrap() {
                "TypeError" | "AttributeError" => IntentDataError::CompanyStructure,
                "RuntimeError" if case["message"].as_str().unwrap().starts_with("Company") => {
                    IntentDataError::CompanyUnavailable
                }
                "RuntimeError" => IntentDataError::PlanUnavailable,
                other => panic!("unexpected Python error {other}"),
            };
            assert_eq!(result, Err(expected), "{}", case["name"]);
        }
    }
}
