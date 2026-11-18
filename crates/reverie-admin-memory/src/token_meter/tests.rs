use super::*;

fn properties(context: Value, slots: Value) -> budget::Properties {
    serde_json::from_value(json!({
        "default_generation_settings": {"n_ctx": context},
        "total_slots": slots,
    }))
    .unwrap()
}

#[test]
fn context_requires_one_slot_and_a_positive_integer() {
    let budget = Budget::new(65_536, 512, 0).unwrap();
    assert_eq!(
        budget.context(properties(json!(100_000), json!(1))),
        Ok(65_536)
    );
    assert_eq!(budget.context(properties(json!(1024), json!(1))), Ok(1024));
    for (context, slots) in [(0, 1), (65_536, 2)] {
        assert_eq!(
            budget.context(properties(json!(context), json!(slots))),
            Err(Failure::Invalid)
        );
    }
    for (context, slots) in [
        (json!(true), json!(1)),
        (json!(64), json!(true)),
        (json!(64.0), json!(1)),
    ] {
        assert!(
            serde_json::from_value::<budget::Properties>(json!({
                "default_generation_settings": {"n_ctx": context},
                "total_slots": slots,
            }))
            .is_err()
        );
    }
}

#[test]
fn reserve_includes_the_margin_and_every_image() {
    let image = json!({"type": "image_url", "image_url": {"url": "data:image/png;base64,fixture"}});
    let one = json!({"messages": [{"content": [{"type": "text", "text": "look"}, image]}]});
    let two = json!({"messages": [{"content": [image, image]}]});
    let text = Budget::new(4096, 512, 0).unwrap();
    assert!(text.stats(&one, 4096, 600, 100).is_err());
    assert!(!text.stats(&json!({}), 1024, 600, 256).unwrap().admitted);
    let vision = Budget::new(4096, 512, 2048).unwrap();
    let fits = vision.stats(&one, 4096, 600, 100).unwrap();
    assert!(fits.admitted);
    assert_eq!(fits.image_tokens, 2048);
    assert!(!vision.stats(&one, 4096, 600, 1800).unwrap().admitted);
    let over = vision.stats(&two, 4096, 600, 100).unwrap();
    assert!(!over.admitted);
    assert_eq!(over.image_tokens, 4096);
    assert!(Budget::new(4096, 512, 8193).is_err());
}

#[test]
fn malformed_budgets_tool_templates_and_tokens_refuse() {
    for value in [json!(null), json!(true), json!(0), json!(2.0), json!(-1)] {
        assert!(budget::completion(&json!({"max_tokens": value})).is_err());
    }
    let payload = json!({"tools": [{"function": {"name": "read_file"}}]});
    assert!(budget::require_tools(&payload, "system tool read_file task").is_ok());
    assert!(budget::require_tools(&payload, "system task").is_err());
    assert!(serde_json::from_value::<Tokens>(json!({"tokens": [true]})).is_err());
    let mixed: Tokens = serde_json::from_value(json!({"tokens": [1, 1.0]})).unwrap();
    assert!(budget::token_count(&mixed.tokens).is_err());
    let integers: Tokens = serde_json::from_value(json!({"tokens": [1, -1]})).unwrap();
    assert_eq!(budget::token_count(&integers.tokens), Ok(2));
}

#[test]
fn large_counts_never_wrap_into_an_admitted_budget() {
    let budget = Budget::new(u64::MAX, u64::MAX, 0).unwrap();
    let outcome = budget.stats(&json!({}), u64::MAX, 1, u64::MAX).unwrap();
    assert!(!outcome.admitted);
}
