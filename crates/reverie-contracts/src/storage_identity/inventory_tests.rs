use super::*;
use serde_json::{Value as Json, json};

const EID: &str = "11111111-1111-4111-8111-111111111111";
const SID: &str = "22222222-2222-4222-8222-222222222222";
fn metadata(value: &Json) -> Metadata {
    decode_metadata(&serde_json::to_vec(value).unwrap()).unwrap()
}
fn company() -> Json {
    json!({"employees":[{"id":EID,"sessionId":SID,"owner":"PRIVATE_OWNER",
        "name":"PRIVATE_NAME","desiredRunning":true,"onVacation":false,
        "runtimeRecipe":{"mode":"codex","runtimeThreads":{"main":"PRIVATE_THREAD"},
        "configs":{"codexConfig":{"model":"PRIVATE_MODEL"}}}}],"retired":[]})
}
fn report(company: &Json, state: Option<&Json>) -> Json {
    let state = state.map(metadata);
    serde_json::from_slice(
        &metadata(company)
            .owner_inventory(state.as_ref(), None)
            .unwrap()
            .encode(),
    )
    .unwrap()
}
#[test]
fn inventory_preserves_legacy_intent_shapes_without_exposing_private_fields() {
    let mut company = company();
    let state = json!({"sessions":{SID:{"model":"PRIVATE_MODEL","runtimeThreads":{"main":"PRIVATE_THREAD"}}}});
    let full = report(&company, Some(&state));
    let encoded = full.to_string();
    for secret in [
        "PRIVATE_OWNER",
        "PRIVATE_NAME",
        "PRIVATE_MODEL",
        "PRIVATE_THREAD",
    ] {
        assert!(!encoded.contains(secret));
    }
    assert_eq!(full["employees"][0]["employeeId"], EID);
    assert_eq!(full["employees"][0]["sessionId"], SID);
    assert_eq!(full["employees"][0]["desiredRunning"], true);
    assert_eq!(full["employees"][0]["onVacation"], false);
    assert!(full["employees"][0].get("sessionGeneration").is_none());
    company["employees"][0]
        .as_object_mut()
        .unwrap()
        .remove("desiredRunning");
    company["employees"][0]["onVacation"] = Json::Null;
    let legacy = report(&company, None);
    assert!(legacy["employees"][0].get("desiredRunning").is_none());
    assert_eq!(legacy["employees"][0]["onVacation"], Json::Null);
    assert_eq!(legacy["state"], Json::Null);
    assert_eq!(legacy["declaredPlans"], Json::Null);
    assert_eq!(legacy["readOnly"], true);
    assert_eq!(legacy["backup"], false);
}
#[test]
fn inventory_fingerprints_change_for_private_recipe_and_retired_records() {
    let mut original = company();
    let before = report(&original, None);
    original["employees"][0]["runtimeRecipe"]["configs"]["codexConfig"]["model"] = json!("another");
    let after = report(&original, None);
    assert_ne!(
        before["employees"][0]["runtimeRecipeDigest"],
        after["employees"][0]["runtimeRecipeDigest"]
    );
    let retired = original["employees"][0].take();
    original["employees"] = json!([]);
    original["retired"] = json!([retired]);
    assert_eq!(report(&original, None)["employees"][0]["retired"], true);
}
#[test]
fn inventory_refuses_ambiguous_or_malformed_metadata_instead_of_partial_rows() {
    let mut duplicate = company();
    duplicate["retired"] = duplicate["employees"].clone();
    assert!(metadata(&duplicate).owner_inventory(None, None).is_err());
    for field in ["desiredRunning", "onVacation"] {
        let mut invalid = company();
        invalid["employees"][0][field] = json!(1);
        assert!(metadata(&invalid).owner_inventory(None, None).is_err());
    }
    let state = metadata(&json!({"sessions":[]}));
    assert!(
        metadata(&company())
            .owner_inventory(Some(&state), None)
            .is_err()
    );
    let plans = metadata(&json!([{"id":"bad"}]));
    assert!(
        metadata(&company())
            .owner_inventory(None, Some(&plans))
            .is_err()
    );
}
#[test]
fn literal_accepted_legacy_text_ids_and_integral_generation_are_not_uuid_migrations() {
    let company = decode_metadata(br#"{"employees":[{"id":"existing-expert","sessionId":"existing-session","sessionGeneration":1.0}],"retired":[]}"#).unwrap();
    let observed: Json =
        serde_json::from_slice(&company.owner_inventory(None, None).unwrap().encode()).unwrap();
    assert_eq!(observed["employees"][0]["employeeId"], "existing-expert");
    assert_eq!(observed["employees"][0]["sessionId"], "existing-session");
    assert_eq!(observed["employees"][0]["sessionGeneration"], "1");
}

#[test]
fn company_snapshot_digest_reuses_full_inventory_fingerprint_without_projection_loss() {
    let mut original = company();
    original["unprojectedPrivateField"] = json!({"value":"PRIVATE_FULL_DOCUMENT"});
    let decoded = metadata(&original);
    let fingerprint = decoded.company_snapshot_digest().unwrap();
    assert_eq!(report(&original, None)["companyDigest"], fingerprint);
    let pretty = decode_metadata(&serde_json::to_vec_pretty(&original).unwrap()).unwrap();
    assert_eq!(pretty.company_snapshot_digest().unwrap(), fingerprint);
    original["unprojectedPrivateField"]["value"] = json!("changed");
    assert_ne!(
        metadata(&original).company_snapshot_digest().unwrap(),
        fingerprint
    );
    assert_eq!(fingerprint.len(), 64);
    assert!(!fingerprint.contains("PRIVATE_FULL_DOCUMENT"));
}

#[test]
fn company_snapshot_digest_refuses_ambiguous_current_and_retired_identity() {
    let mut duplicate = company();
    duplicate["retired"] = duplicate["employees"].clone();
    assert!(metadata(&duplicate).company_snapshot_digest().is_err());
}
