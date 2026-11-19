use super::{Kind, Observation, Settings, TraceKind, Transcript, clean, endpoint};
use serde_json::json;

fn transcript() -> Transcript {
    let settings: Settings = serde_json::from_value(json!({
        "interactive": false, "capture": true, "api_base": "https://model.invalid/v1",
        "model": "configured", "self_name": "Fixture", "poll_s": 15,
        "prompt_cap_chars": 60000, "reply_max_tokens": 1024, "message_cap_chars": 4000,
        "coding": false, "search": false, "memory": false, "secrets": []
    }))
    .unwrap();
    Transcript::new(123, settings, true)
}

#[test]
fn strips_control_sequences_and_redacts_credentials_before_display() {
    let secrets = vec!["fixture-password".into()];
    let line = clean(
        &secrets,
        "fixture-password Bearer abc123 token=hidden \x1b]52;c;clip\x07\x1b[31mred\x1b[0m",
    );
    for hidden in ["fixture-password", "abc123", "hidden", "clip", "\x1b"] {
        assert!(!line.contains(hidden), "{line}");
    }
    assert!(line.ends_with("red"));
    assert_eq!(
        endpoint("https://owner:pass@[::1]:123/v1?key=secret#fragment"),
        "https://[::1]:123/v1"
    );
}

#[test]
fn coalesces_trace_and_caps_transcript_and_unicode_rows() {
    let mut view = transcript();
    view.trace(
        [
            (TraceKind::Thinking, "one ".into()),
            (TraceKind::Thinking, "two".into()),
        ]
        .into_iter(),
    );
    view.trace(
        [
            (TraceKind::Thinking, " three".into()),
            (TraceKind::Answer, "answer".into()),
        ]
        .into_iter(),
    );
    assert_eq!(view.records.len(), 2);
    assert_eq!(view.records[0].text, "one two three");
    assert_eq!(view.records[1].text, "answer");
    for _ in 0..10 {
        view.trace([(TraceKind::Thinking, "界".repeat(4096))].into_iter());
    }
    let row = view.records.back().unwrap();
    assert!(row.text.starts_with("[earlier trace text omitted]"));
    assert!(row.text.chars().count() <= 12_000);
    assert!(matches!(row.kind, Kind::Trace(TraceKind::Thinking)));
    for _ in 0..300 {
        view.observe(Observation::Note {
            text: "bounded".into(),
        });
    }
    assert_eq!(view.records.len(), 200);
}
