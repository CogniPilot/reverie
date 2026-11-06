use reverie_contracts::ops_command::{OpsCommand, OpsReply};
use reverie_core::worker_options::OpsServiceId;
use serde_json::Value;
fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/ops-command-python.json")).unwrap()
}
fn bytes(case: &Value) -> Vec<u8> {
    case["rawHex"]
        .as_str()
        .unwrap()
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}
#[test]
fn exact_unmodified_python_closed_commands_and_byte_encodings() {
    let vectors = fixture();
    for case in vectors["commands"].as_array().unwrap() {
        let result = OpsCommand::decode(&bytes(case));
        assert_eq!(
            result.is_ok(),
            case["accepted"].as_bool().unwrap(),
            "{}",
            case["name"]
        );
        if let Ok(command) = result {
            assert_eq!(
                command.canonical_bytes(),
                case["canonical"].as_str().unwrap().as_bytes(),
                "{}",
                case["name"]
            );
            assert_eq!(
                command.action().is_effect(),
                case["effect"].as_bool().unwrap()
            );
        }
    }
}
#[test]
fn exact_unmodified_python_reply_canonical_bytes_finite_values_and_truthiness() {
    let vectors = fixture();
    for case in vectors["replies"].as_array().unwrap() {
        let result = OpsReply::decode(&bytes(case));
        assert_eq!(
            result.is_ok(),
            case["accepted"].as_bool().unwrap(),
            "{}",
            case["name"]
        );
        if let Ok(reply) = result {
            assert_eq!(
                reply.canonical_bytes(),
                case["canonical"].as_str().unwrap().as_bytes(),
                "{}",
                case["name"]
            );
            assert_eq!(reply.succeeded(), case["success"].as_bool().unwrap());
        }
    }
}
#[test]
fn typed_read_constructors_share_the_same_exact_command_wire() {
    let id = |value| OpsServiceId::parse(value).unwrap();
    let command = OpsCommand::status(&id("req-1"), &id("website"));
    assert_eq!(
        OpsCommand::decode(command.canonical_bytes())
            .unwrap()
            .canonical_bytes(),
        command.canonical_bytes()
    );
    let command = OpsCommand::inspect(&id("req-1"), &id("website"), &id("operation-1"));
    assert_eq!(
        OpsCommand::decode(command.canonical_bytes())
            .unwrap()
            .canonical_bytes(),
        command.canonical_bytes()
    );
}
