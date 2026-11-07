use super::lower_codepoints;
#[test]
fn actual_python_lower_preserves_surrogates_and_final_sigma_context() {
    let cases: serde_json::Value = serde_json::from_str(include_str!("lower-python.json")).unwrap();
    assert_eq!(cases.as_array().unwrap().len(), 14);
    for case in cases.as_array().unwrap() {
        let points = |name: &str| {
            case[name]
                .as_array()
                .unwrap()
                .iter()
                .map(|n| n.as_u64().unwrap() as u32)
                .collect::<Vec<_>>()
        };
        assert_eq!(lower_codepoints(&points("input")), points("expected"));
    }
}
