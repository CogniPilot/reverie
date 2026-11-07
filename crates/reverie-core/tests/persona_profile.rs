use reverie_core::{
    PythonText,
    persona::{ProfileEntry, SectionAliases, render_profile},
};
fn text(value: &serde_json::Value) -> PythonText {
    PythonText::try_new(
        value
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap() as u32)
            .collect(),
    )
    .unwrap()
}
#[test]
fn actual_derived_profile_unicode_rounding_aliases_limits_and_ties_match() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/persona-profile-python.json")).unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let entries = case["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| ProfileEntry {
                id: v["id"].as_i64().unwrap(),
                importance: f64::from_bits(v["importanceBits"].as_u64().unwrap()),
                created_at: f64::from_bits(v["createdBits"].as_u64().unwrap()),
                text: text(&v["text"]),
                section: text(&v["section"]),
            })
            .collect::<Vec<_>>();
        let owner = text(&case["ownerAliases"]);
        let agent = text(&case["agentAliases"]);
        let aliases = SectionAliases::from_text(owner.as_text_ref(), agent.as_text_ref());
        let result = render_profile(&entries, case["maximum"].as_i64().unwrap(), &aliases);
        assert_eq!(result.is_ok(), case["accepted"].as_bool().unwrap());
        if let Ok(result) = result {
            assert_eq!(result, text(&case["output"]));
        }
    }
}
