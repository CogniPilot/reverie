use reverie_contracts::{
    storage_identity::MetadataText,
    worker_config,
    worker_launch::{self, CreateObservations, WorkerRequest},
};
use reverie_core::ids::ProfileSessionId;
use serde::Deserialize;
use sha2::{Digest, Sha256};
#[derive(Deserialize)]
struct Corpus<T> {
    cases: Vec<T>,
}
#[derive(Deserialize)]
struct RequestCase {
    name: String,
    configuration: String,
    raw: String,
    #[serde(rename = "rawHex")]
    raw_hex: Option<String>,
    repeat: Option<Repeat>,
    sha256: String,
    accepted: bool,
    expected: Option<Expected>,
}
#[derive(Deserialize)]
struct Repeat {
    point: u32,
    count: usize,
    #[serde(default, rename = "rawUnicode")]
    raw_unicode: bool,
}
#[derive(Deserialize)]
struct Expected {
    cwd: Vec<u32>,
    command: Option<Vec<u32>>,
    env: Vec<(String, Option<Vec<u32>>)>,
    attach: Option<bool>,
    #[serde(rename = "hasAttach")]
    has_attach: bool,
}
fn raw(case: &RequestCase) -> Vec<u8> {
    if let Some(raw) = &case.raw_hex {
        let raw = raw
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(format!("{:x}", Sha256::digest(&raw)), case.sha256);
        return raw;
    }
    let raw = if let Some(repeat) = &case.repeat {
        let unit = if repeat.point < 128 || repeat.raw_unicode {
            char::from_u32(repeat.point).unwrap().to_string()
        } else {
            format!("\\u{:04x}", repeat.point)
        };
        case.raw.replace("$REPEAT", &unit.repeat(repeat.count))
    } else {
        case.raw.clone()
    };
    let raw = raw.into_bytes();
    assert_eq!(
        format!("{:x}", Sha256::digest(&raw)),
        case.sha256,
        "{} sealed input",
        case.name
    );
    raw
}
#[test]
fn actual_python_request_frame_and_validation_vectors() {
    let corpus: Corpus<RequestCase> =
        serde_json::from_str(include_str!("fixtures/worker_launch/requests.json")).unwrap();
    assert_eq!(corpus.cases.len(), 131);
    for case in corpus.cases {
        let config = worker_config::decode(case.configuration.as_bytes()).unwrap();
        let result = WorkerRequest::decode(&raw(&case), &config);
        assert_eq!(result.is_ok(), case.accepted, "{}: {result:?}", case.name);
        if let Some(expected) = case.expected {
            let actual = result.unwrap();
            assert_eq!(
                actual.directory().codepoints(),
                expected.cwd,
                "{}",
                case.name
            );
            if let Some(command) = expected.command {
                assert_eq!(actual.command().codepoints(), command, "{}", case.name);
            }
            assert_eq!(actual.attach_only(), expected.attach);
            assert_eq!(actual.attach_only().is_some(), expected.has_attach);
            let entries = actual.environment().entries();
            assert_eq!(entries.len(), expected.env.len());
            for ((key, value), (wanted_key, wanted_value)) in entries.iter().zip(expected.env) {
                assert_eq!(key.as_str(), wanted_key, "{}", case.name);
                assert_value(value, wanted_value, &case.name);
            }
        }
    }
}
fn assert_value(actual: &[u32], expected: Option<Vec<u32>>, name: &str) {
    if let Some(expected) = expected {
        assert_eq!(actual, expected, "{name}");
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateCase {
    name: String,
    configuration: String,
    session: String,
    home: String,
    scratch: Option<String>,
    security: Vec<String>,
    runtime: Vec<String>,
    gpu: Vec<String>,
    result_name: String,
    digest: String,
    args: Vec<Vec<u32>>,
}
fn texts(values: &[String]) -> Vec<MetadataText> {
    values
        .iter()
        .map(|text| MetadataText::from_scalar_text(text))
        .collect()
}
#[test]
fn actual_python_complete_create_argv_and_hash_vectors() {
    let corpus: Corpus<CreateCase> =
        serde_json::from_str(include_str!("fixtures/worker_launch/create.json")).unwrap();
    assert_eq!(corpus.cases.len(), 9);
    for case in corpus.cases {
        let config = worker_config::decode(case.configuration.as_bytes()).unwrap();
        let session = ProfileSessionId::parse(&case.session).unwrap();
        let security = texts(&case.security);
        let runtime = texts(&case.runtime);
        let scratch = case.scratch.as_deref().map(MetadataText::from_scalar_text);
        let result = worker_launch::create_arguments(
            &config,
            &session,
            &MetadataText::from_scalar_text(&case.home),
            scratch.as_ref(),
            CreateObservations {
                security: &security,
                runtime: &runtime,
                gpu: &case.gpu,
                employee: None,
            },
        )
        .unwrap();
        assert_eq!(result.name(), case.result_name, "{}", case.name);
        assert_eq!(
            result.config_digest().to_hex(),
            case.digest,
            "{}",
            case.name
        );
        assert_eq!(
            result
                .args()
                .iter()
                .map(|arg| arg.codepoints().to_vec())
                .collect::<Vec<_>>(),
            case.args,
            "{}",
            case.name
        );
    }
}
