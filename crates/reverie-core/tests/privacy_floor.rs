use reverie_core::{PythonText, privacy_floor::targets_private_person};
use serde_json::Value;
fn text(raw: &Value) -> PythonText {
    PythonText::try_new(
        raw.as_array()
            .unwrap()
            .iter()
            .map(|point| u32::try_from(point.as_u64().unwrap()).unwrap())
            .collect(),
    )
    .unwrap()
}
#[test]
fn actual_unpatched_python_private_person_floor_matches_lossless_unicode_grammar() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/privacy-floor-python-interop.json")).unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    assert!(cases.len() > 4000);
    for (index, case) in cases.iter().enumerate() {
        let input = text(&case["text"]);
        let names = case["names"]
            .as_array()
            .unwrap()
            .iter()
            .map(text)
            .collect::<Vec<_>>();
        assert_eq!(
            targets_private_person(input.as_text_ref(), &names),
            case["expected"].as_bool().unwrap(),
            "actual Python case{index}: {case}"
        );
    }
}
