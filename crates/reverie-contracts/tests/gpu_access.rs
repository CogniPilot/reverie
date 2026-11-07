use reverie_contracts::{gpu_access, storage_identity::decode_ordered_metadata};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Corpus {
    source_sha256: String,
    commands: Vec<Command>,
    queues: Vec<Queue>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Command {
    name: String,
    raw_hex: String,
    decode: bool,
    code: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Queue {
    name: String,
    raw_hex: String,
    code: String,
}
fn raw(value: &str) -> Vec<u8> {
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|bytes| u8::from_str_radix(std::str::from_utf8(bytes).unwrap(), 16).unwrap())
        .collect()
}
#[test]
fn actual_owner_command_and_request_store_cases_preserve_phase_and_types() {
    let corpus: Corpus =
        serde_json::from_str(include_str!("fixtures/gpu_access/legacy.json")).unwrap();
    assert_eq!(corpus.source_sha256.len(), 64);
    assert!(corpus.commands.len() > 60 && corpus.queues.len() > 30);
    for case in corpus.commands {
        let result = gpu_access::decode_command(&raw(&case.raw_hex));
        if !case.decode {
            let expected = if matches!(
                case.code.as_str(),
                "GPU_REQUEST_NONFINITE" | "GPU_REQUEST_DUPLICATE_KEY"
            ) {
                case.code.as_str()
            } else {
                "GPU_REQUEST_JSON"
            };
            assert_eq!(result.err().unwrap().code(), expected, "{}", case.name);
            continue;
        }
        if case.code == "GPU_OWNER_CONTROL_UNAVAILABLE" {
            assert!(result.is_ok(), "{}: {:?}", case.name, result.err());
        } else {
            assert_eq!(result.err().unwrap().code(), case.code, "{}", case.name);
        }
    }
    for case in corpus.queues {
        let metadata = decode_ordered_metadata(&raw(&case.raw_hex)).unwrap();
        let result = gpu_access::decode_requests(&metadata);
        if case.code == "READY" {
            let document = result.unwrap();
            let roundtrip =
                decode_ordered_metadata(&gpu_access::encode_requests(&document)).unwrap();
            assert_eq!(
                document,
                gpu_access::decode_requests(&roundtrip).unwrap(),
                "{}",
                case.name
            );
        } else {
            assert_eq!(result.unwrap_err().code(), case.code, "{}", case.name);
        }
    }
}
#[test]
fn employee_identity_validation_is_deferred_until_the_admitted_current_phase() {
    let command =
        gpu_access::decode_command(br#"{"action":"gpu-access-status","employeeId":null}"#).unwrap();
    let gpu_access::GpuCommand::Status(employee) = command else {
        panic!("status");
    };
    assert_eq!(employee.employee_id().unwrap_err().code(), "UUID");
}
