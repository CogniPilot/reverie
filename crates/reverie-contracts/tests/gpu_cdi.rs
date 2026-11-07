use reverie_contracts::gpu_access::{CdiDocument, CdiSelectedEdits};
use reverie_core::device_policy::NvidiaCdiDevice;
use serde::Deserialize;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Corpus {
    source_sha256: String,
    device: String,
    cases: Vec<Case>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    name: String,
    raw_hex: String,
    decoded: bool,
    result: Option<Projection>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Projection {
    numeric_nodes: Vec<String>,
    mount_count: usize,
    all_mounts_readonly: bool,
    hook_count: usize,
}
fn raw(value: &str) -> Vec<u8> {
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}
#[test]
fn actual_safe_loader_and_selected_cdi_policy_cases_match_without_json_coercion() {
    let corpus: Corpus =
        serde_json::from_str(include_str!("fixtures/gpu_access/cdi.json")).unwrap();
    assert_eq!(corpus.source_sha256.len(), 64);
    assert!(corpus.cases.len() > 100);
    let device = NvidiaCdiDevice::parse(&corpus.device).unwrap();
    let mut failures = Vec::new();
    for case in corpus.cases {
        let result = CdiDocument::decode(&raw(&case.raw_hex));
        if result.is_ok() != case.decoded {
            failures.push(format!(
                "{}: decoded expected {} actual {}",
                case.name,
                case.decoded,
                result.is_ok()
            ));
            continue;
        }
        if let Ok(document) = result {
            let selected = document.selected(&device);
            if let Some(expected) = case.result {
                match selected {
                    Ok(Some(value)) => assert_projection(&case.name, &value, &expected),
                    _ => failures.push(format!("{}: expected selected", case.name)),
                }
            } else if matches!(selected, Ok(Some(_))) {
                failures.push(format!("{}: unexpectedly selected", case.name));
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
fn assert_projection(name: &str, value: &CdiSelectedEdits, expected: &Projection) {
    assert_eq!(
        value
            .numeric_nodes()
            .iter()
            .map(|value| value.scalar_text().unwrap())
            .collect::<Vec<_>>(),
        expected.numeric_nodes,
        "{name}"
    );
    assert_eq!(value.mount_count(), expected.mount_count, "{name}");
    assert_eq!(
        value.all_mounts_readonly(),
        expected.all_mounts_readonly,
        "{name}"
    );
    assert_eq!(value.hook_count(), expected.hook_count, "{name}");
}
#[test]
fn actual_pinned_loader_consumes_first_sign_before_decimal_fallback() {
    let corpus: serde_json::Value = serde_json::from_str(include_str!(
        "fixtures/gpu_access/cdi-double-sign-python.json"
    ))
    .unwrap();
    assert_eq!(corpus["pyyaml"], "6.0.3");
    assert_eq!(
        corpus["constructorSha256"],
        "f178040c9a9723a1e42588f1737bfb8cf9cf364cc6e49fb9a609d62ca3ddf2df"
    );
    let cases = corpus["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 26);
    let mut failures = Vec::new();
    for case in cases {
        let decoded = CdiDocument::decode(&raw(case["rawHex"].as_str().unwrap())).is_ok();
        if decoded != case["decoded"].as_bool().unwrap() {
            failures.push(format!(
                "{}: loader {} Rust {decoded}",
                case["value"], case["decoded"]
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
