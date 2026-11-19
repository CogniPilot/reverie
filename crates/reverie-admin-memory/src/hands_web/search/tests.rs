use super::{Search, render};
use serde_json::{Map, Value, json};

fn settings() -> Map<String, Value> {
    json!({
        "search_url":"http://[::1]:8888/searx/",
        "search_results":2,
        "search_timeout_s":1,
        "search_max_bytes":4096
    })
    .as_object()
    .unwrap()
    .to_owned()
}

#[test]
fn validates_bounds_and_rejects_invalid_endpoints_before_connecting() {
    assert!(Search::new("valid", &settings()).is_some());
    for query in ["", "  ", "ab\ncd", &"a".repeat(301)] {
        assert!(Search::new(query, &settings()).is_none());
    }
    for (key, invalid) in [
        ("search_url", json!("http://host/base?q=x")),
        ("search_url", json!("http://a:b@host")),
        ("search_url", json!("file:///tmp")),
        ("search_results", json!(11)),
        ("search_timeout_s", json!(21)),
        ("search_max_bytes", json!(2_000_001)),
    ] {
        let mut settings = settings();
        settings.insert(key.into(), invalid);
        assert!(Search::new("valid", &settings).is_none());
    }
}

#[test]
fn preserves_projection_order_and_caps_each_field_by_unicode_characters() {
    let payload = json!({"results": [
        {"title": "é".repeat(201), "url": "界".repeat(301), "content": "🎉".repeat(501)},
        {"title": "Second", "url": null}, "ignored beyond the configured count"
    ]});
    assert_eq!(
        render(&payload, 2).unwrap(),
        format!(
            "- {} <{}>\n  {}\n- Second <>\n  ",
            "é".repeat(200),
            "界".repeat(300),
            "🎉".repeat(500)
        )
    );
    for empty in [json!({}), json!({"results": null}), json!({"results": []})] {
        assert_eq!(render(&empty, 1).as_deref(), Some("(no results)"));
    }
}
