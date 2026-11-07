use reverie_contracts::{worker_config, worker_launch::ProtectedWorkerRequest};
use serde::Deserialize;
use sha2::{Digest, Sha256};
#[derive(Deserialize)]
struct Corpus {
    configuration: String,
    cases: Vec<Case>,
}
#[derive(Deserialize)]
struct Case {
    name: String,
    #[serde(rename = "rawHex")]
    raw: String,
    sha256: String,
    accepted: bool,
    expected: Option<Expected>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Expected {
    reference: String,
    request_digest: String,
    env_keys: Vec<String>,
}
#[test]
fn original_l_envelope_request_digest_and_insertion_order_vectors() {
    let corpus: Corpus =
        serde_json::from_str(include_str!("fixtures/worker_launch/protected.json")).unwrap();
    assert_eq!(corpus.cases.len(), 12);
    let config = worker_config::decode(corpus.configuration.as_bytes()).unwrap();
    for case in corpus.cases {
        let raw = case
            .raw
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            format!("{:x}", Sha256::digest(&raw)),
            case.sha256,
            "{} sealed input",
            case.name
        );
        let result = ProtectedWorkerRequest::decode(&raw, &config);
        assert_eq!(result.is_ok(), case.accepted, "{}", case.name);
        if let Some(expected) = case.expected {
            let parsed = result.unwrap();
            assert_eq!(
                parsed.reference().as_str(),
                expected.reference,
                "{}",
                case.name
            );
            assert_eq!(
                parsed.request_digest().as_str(),
                expected.request_digest,
                "{}",
                case.name
            );
            assert_eq!(
                parsed
                    .request()
                    .environment()
                    .entries()
                    .iter()
                    .map(|(key, _)| key.as_str())
                    .collect::<Vec<_>>(),
                expected.env_keys,
                "{}",
                case.name
            );
        }
    }
}
