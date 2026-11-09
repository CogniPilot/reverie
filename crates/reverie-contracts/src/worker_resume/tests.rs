use super::*;
use serde::Deserialize;
#[derive(Deserialize)]
struct Case {
    name: String,
    mode: String,
    #[serde(rename = "rawHex")]
    raw: String,
    ok: bool,
    error: Option<String>,
    digest: Option<String>,
    canonical: Option<String>,
}
fn bytes(value: &str) -> Vec<u8> {
    assert!(value.len().is_multiple_of(2));
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}
fn actual(case: &Case) -> Result<Option<String>> {
    let raw = bytes(&case.raw);
    match case.mode.as_str() {
        "recipe" => recipe_digest(&raw).map(|digest| Some(digest.as_str().into())),
        "decode" => ResumeFrame::decode(&raw).map(|_| None),
        "register" => ResumeFrame::decode(&raw)?
            .require_registration()
            .map(|()| None),
        "canonical" => ResumeFrame::decode_canonical(&raw)?
            .canonical()
            .map(|bytes| Some(String::from_utf8(bytes).expect("ASCII canonical JSON"))),
        _ => panic!("fixed actual source fixture mode"),
    }
}
#[test]
fn unchanged_python_protocol_and_recipe_oracle_vectors_match() {
    let cases: Vec<Case> = serde_json::from_str(include_str!(
        "../../tests/fixtures/worker-resume-python.json"
    ))
    .unwrap();
    assert_eq!(cases.len(), 129);
    for case in cases {
        let outcome = actual(&case);
        assert_eq!(outcome.is_ok(), case.ok, "{}: {:?}", case.name, outcome);
        match outcome {
            Ok(output) => assert_eq!(output, case.digest.or(case.canonical), "{}", case.name),
            Err(error) => assert_eq!(Some(error.code()), case.error.as_deref(), "{}", case.name),
        }
    }
}
