use super::*;
use crate::storage_identity::MetadataText;
use serde_json::{Value as Json, json};

fn fixture() -> Json {
    json!({"version":1,"mode":"owner-only","issuer":"issuer:1","epoch":"epoch-1",
        "serverContainerId":"a".repeat(64),
        "paths":{
            "config":{"host":"/private/goals.json","server":"/private/goals.json"},
            "key":{"host":"/private/key","server":"/private/key"},
            "canonical":{"host":"/private/company.json","server":"/private/company.json"},
            "nonce":{"host":"/private/nonces/state.json","server":"/private/nonces/state.json"},
            "authority":{"host":"/private/authority","server":"/private/authority"}},
        "nonce":{"storeId":"11111111-2222-3333-4444-555555555555","capacity":32,"flockExecutable":"/nix/store/fixed/flock"},
        "server":{"brokerSocket":"/private/control/broker.sock","custodyClient":"/nix/store/fixed/client"}})
}
fn config(raw: &[u8]) -> Result<GoalPrivateConfig> {
    GoalPrivateConfig::decode(
        raw,
        &MetadataText::from_scalar_text("/private/goals.json"),
        &MetadataText::from_scalar_text("/private/company.json"),
    )
}
fn encoded(text: &str) -> Vec<Vec<u8>> {
    let mut utf16 = vec![0xff, 0xfe];
    utf16.extend(text.encode_utf16().flat_map(u16::to_le_bytes));
    let mut utf32 = vec![0, 0, 0xfe, 0xff];
    utf32.extend(text.chars().flat_map(|c| u32::from(c).to_be_bytes()));
    vec![text.as_bytes().to_vec(), utf16, utf32]
}
#[test]
fn bytes_requests_keep_encoding_detection_last_duplicate_and_closed_shape() {
    for raw in encoded(r#"{"action":"old","action":"goal-custody"}"#) {
        assert!(GoalCustodyRequest::decode(&raw).is_ok());
    }
    for raw in [
        r#"{}"#,
        r#"[]"#,
        r#"{"action":"goal-custody","path":"/private/key"}"#,
        r#"{"action":"goal-custody","caller":"owner"}"#,
        r#"{"action":"goal-custody","action":"old"}"#,
    ] {
        assert!(GoalCustodyRequest::decode(raw.as_bytes()).is_err());
    }
}
#[test]
fn private_configuration_preserves_bytes_semantics_and_explicit_mode() {
    let original = config(fixture().to_string().as_bytes()).unwrap();
    for raw in encoded(&fixture().to_string()) {
        let checked = config(&raw).unwrap();
        checked.require_owner_only().unwrap();
        assert!(original.equivalent(&checked));
        assert_eq!(checked.paths().len(), 5);
    }
    let mut employee = fixture();
    employee["mode"] = json!("owner-and-employee");
    let checked = config(employee.to_string().as_bytes()).unwrap();
    assert_eq!(checked.require_owner_only(), Err(GoalDataError::Mode));
    assert!(!original.equivalent(&checked));
}
#[test]
fn source_exact_integer_and_scope_rules_refuse_before_nonce_validation() {
    for version in [json!(true), json!(1.0), json!(0), json!(2)] {
        let mut value = fixture();
        value["version"] = version;
        assert!(config(value.to_string().as_bytes()).is_err());
    }
    for capacity in [json!(false), json!(1.0), json!(0), json!(4097)] {
        let mut value = fixture();
        value["nonce"]["capacity"] = capacity;
        assert!(config(value.to_string().as_bytes()).is_err());
    }
    let mut value = fixture();
    value["paths"]["key"]["host"] = json!("/nix/store/private-key");
    value["nonce"]["capacity"] = json!(false);
    assert!(matches!(
        config(value.to_string().as_bytes()),
        Err(GoalDataError::Scope)
    ));
    value["paths"]["key"]["host"] = json!("/nix/store-other/private-key");
    value["nonce"]["capacity"] = json!(32);
    assert!(config(value.to_string().as_bytes()).is_ok());
}
#[test]
fn path_rules_preserve_python_codepoints_and_reject_lexical_aliases() {
    for path in [
        "/",
        "/private//key",
        "/private/./key",
        "/private/../key",
        "/private/key/",
        "/private/key\n",
    ] {
        let mut value = fixture();
        value["paths"]["key"]["host"] = json!(path);
        assert!(config(value.to_string().as_bytes()).is_err(), "{path:?}");
    }
    let raw = fixture()
        .to_string()
        .replace("/private/key", "/private/\\udcff");
    let checked = config(raw.as_bytes()).unwrap();
    assert!(
        checked
            .path(GoalPrivatePath::Key)
            .host()
            .codepoints()
            .ends_with(&[0xdcff])
    );
    let mut value = fixture();
    value["paths"]["key"]["host"] = json!("//private/key");
    assert!(config(value.to_string().as_bytes()).is_ok());
}
#[test]
fn original_path_dictionary_order_survives_last_wins_bytes_decode() {
    let value = fixture();
    let order = ["nonce", "key", "config", "authority", "canonical"];
    let parts: Vec<_> = order
        .iter()
        .map(|name| format!("{}:{}", json!(name), value["paths"][name]))
        .collect();
    let raw = value.to_string().replace(
        &value["paths"].to_string(),
        &format!("{{{}}}", parts.join(",")),
    );
    let checked = config(raw.as_bytes()).unwrap();
    assert_eq!(
        checked
            .paths()
            .map(|(kind, _)| kind.as_str())
            .collect::<Vec<_>>(),
        order
    );
}

#[test]
fn raw_worker_scope_spelling_cannot_be_normalized_into_a_matching_private_scope() {
    let raw = fixture().to_string();
    for (selected, company) in [
        ("/private//goals.json", "/private/company.json"),
        ("/private/goals.json", "/private/./company.json"),
    ] {
        assert!(matches!(
            GoalPrivateConfig::decode(
                raw.as_bytes(),
                &MetadataText::from_scalar_text(selected),
                &MetadataText::from_scalar_text(company),
            ),
            Err(GoalDataError::Scope)
        ));
    }
}
