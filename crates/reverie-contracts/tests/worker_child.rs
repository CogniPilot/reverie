use reverie_contracts::{
    worker_child::{PrivateChildRecord, project_temporary_root},
    worker_config,
    worker_launch::WorkerRequest,
};
use reverie_core::{
    PythonText,
    worker_child::{ChildEnvironment, ChildEnvironmentValue, TemporaryEnvironmentRoot},
};
use serde_json::Value;
use sha2::{Digest, Sha256};

fn corpus() -> Value {
    serde_json::from_str(include_str!("fixtures/worker_child/legacy.json")).unwrap()
}
fn text(value: &str) -> PythonText {
    PythonText::from_scalar_text(value)
}
fn entries(environment: &ChildEnvironment) -> Value {
    Value::Array(
        environment
            .entries()
            .iter()
            .map(|(key, value)| {
                let value = match value {
                    ChildEnvironmentValue::Text(value) => serde_json::json!(value.codepoints()),
                    ChildEnvironmentValue::Other => Value::Null,
                };
                serde_json::json!([key.codepoints(), value])
            })
            .collect(),
    )
}
fn fsencode(points: &[u32]) -> Option<Vec<u8>> {
    let mut bytes = Vec::new();
    for &point in points {
        if (0xdc80..=0xdcff).contains(&point) {
            bytes.push((point - 0xdc00) as u8);
        } else {
            let character = char::from_u32(point)?;
            bytes.extend_from_slice(character.encode_utf8(&mut [0; 4]).as_bytes());
        }
    }
    Some(bytes)
}
#[test]
fn actual_child_default_reader_and_ordered_environment_vectors() {
    let corpus = corpus();
    let cases = corpus["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 44);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let raw = case["raw"].as_str().unwrap().as_bytes();
        assert_eq!(
            format!("{:x}", Sha256::digest(raw)),
            case["sha256"].as_str().unwrap(),
            "{name}"
        );
        let parsed = PrivateChildRecord::decode(raw);
        if ["utf8-bom", "bad-json", "integer-cap"].contains(&name) {
            assert!(parsed.is_err(), "{name}");
            continue;
        }
        let parsed = parsed.unwrap();
        let requested = parsed.requested_environment();
        let trace = case["trace"].as_array().unwrap();
        if requested.is_err() {
            assert!(trace.is_empty(), "{name}");
            continue;
        }
        let directory = parsed.directory();
        if directory.is_err() {
            assert!(trace.is_empty(), "{name}");
            continue;
        }
        let temporary = match directory.unwrap() {
            None => TemporaryEnvironmentRoot::global(),
            Some(path) => match fsencode(path.codepoints()) {
                None => {
                    assert!(trace.is_empty(), "{name}");
                    continue;
                }
                Some(bytes) => project_temporary_root(&bytes),
            },
        };
        let inherited = case["inherited"]
            .as_array()
            .map(|env| {
                env.iter()
                    .map(|pair| {
                        (
                            text(pair[0].as_str().unwrap()),
                            text(pair[1].as_str().unwrap()),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();
        let result = ChildEnvironment::prepare(
            inherited,
            requested.unwrap(),
            &temporary,
            case["shim"].as_bool().unwrap_or(false),
        );
        if result.is_err() {
            assert!(trace.is_empty(), "{name}");
            continue;
        }
        let environment = result.unwrap();
        for event in trace.iter().filter(|event| event["event"] == "relay") {
            let actual = if event["argv"][0] == "/bin/reverie-model-relay" {
                entries(&environment.for_model_relay())
            } else {
                entries(&environment)
            };
            assert_eq!(actual, event["env"], "{name}");
        }
    }
}

#[test]
fn private_reader_keeps_lazy_fields_and_has_no_public_frame_cap() {
    let raw = format!(
        "{{\"env\":{{}},\"cwd\":null,\"ignored\":\"{}\"}}",
        "a".repeat(300_000)
    );
    let record = PrivateChildRecord::decode(raw.as_bytes()).unwrap();
    assert!(record.requested_environment().unwrap().is_empty());
    assert_eq!(record.directory().unwrap(), None);
    assert!(record.command().is_err());
    for raw in [b"\xff{}".as_slice(), b"\xff\xfe{\0}\0".as_slice()] {
        assert!(PrivateChildRecord::decode(raw).is_err());
    }
}

#[test]
fn record_encoder_retains_request_field_order_and_fixed_broker_overrides() {
    let config = worker_config::decode(
        br#"{"mounts":[{"source":"/owned","destination":"/project","readOnly":false}]}"#,
    )
    .unwrap();
    let raw=br#"{"env":{"LANG":"C","REVERIE_SESSION_ID":"old"},"rows":24,"command":"x","cwd":"/project","cols":80,"sessionId":"00000000-0000-0000-0000-000000000000"}"#;
    let request = WorkerRequest::decode(raw, &config).unwrap();
    let encoded = reverie_contracts::worker_child::encode_launch_record(&request);
    let expected = include_bytes!("fixtures/worker_child/producer.json");
    assert_eq!(encoded, expected);
}
