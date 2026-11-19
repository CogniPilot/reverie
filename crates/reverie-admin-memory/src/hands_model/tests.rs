use super::{
    delta::{Display, DisplayKind},
    *,
};

#[derive(Default)]
struct Events(Vec<(&'static str, String)>);

impl Display for Events {
    fn write(&mut self, kind: DisplayKind, value: &str) -> Result<(), Failure> {
        self.0.push((kind.name(), value.into()));
        Ok(())
    }
}

fn event(data: &Value) -> String {
    format!("data: {data}\r\n\r\n")
}

#[test]
fn fragmented_stream_assembles_text_tools_metadata_and_live_display() {
    let mut display = Events::default();
    let mut stream = Stream::new(8192);
    let first = event(&json!({"model": "served", "choices": [{"delta": {
        "reasoning_content": "consider é", "content": "test ",
        "tool_calls": [{"index": 0, "id": "call_", "type": "function",
                        "function": {"name": "run_", "arguments": "{"}}]
    }}]}));
    for byte in first.as_bytes() {
        assert!(!stream.feed(&[*byte], &mut display).unwrap());
    }
    assert_eq!(
        display.0,
        [
            ("thinking", "consider é".into()),
            ("answer", "test ".into())
        ]
    );
    let last = event(&json!({"choices": [{"delta": {
        "content": "works", "tool_calls": [{"index": 0, "id": "1",
        "function": {"name": "test", "arguments": "}"}}]
    }, "finish_reason": "tool_calls"}], "usage": {"prompt_tokens": 12}, "timings": {"predicted_n": 9}}));
    let last = format!("{last}data: [DONE]\n\ntrailing provider data");
    assert!(stream.feed(last.as_bytes(), &mut display).unwrap());
    let result = message(stream.finish(&mut display).unwrap()).unwrap();
    assert_eq!(result["content"], "test works");
    assert_eq!(result["reasoning_content"], "consider é");
    assert_eq!(
        result["tool_calls"],
        json!([{"id": "call_1", "type": "function",
        "function": {"name": "run_test", "arguments": "{}"}}])
    );
    assert_eq!(result["_finish_reason"], "tool_calls");
    assert_eq!(result["_model"], "served");
    assert_eq!(result["_usage"], json!({"prompt_tokens": 12}));
    assert_eq!(result["_timings"], json!({"predicted_n": 9}));
}

fn assemble(bytes: &str, limit: usize) -> Result<Value, Failure> {
    let mut stream = Stream::new(limit);
    let mut display = Events::default();
    stream.feed(bytes.as_bytes(), &mut display)?;
    stream.finish(&mut display)
}

#[test]
fn stream_refuses_incomplete_invalid_or_oversized_output() {
    let done = "data: [DONE]\n\n";
    for data in [
        json!({"choices": [{"delta": {"content": ["bad"]}, "finish_reason": "stop"}]}),
        json!({"choices": [{"delta": {"tool_calls": [{"index": true}]}, "finish_reason": "stop"}]}),
        json!({"choices": [{"delta": {"tool_calls": [{"index": 1}]}, "finish_reason": "stop"}]}),
        json!({"choices": [{"delta": {"content": "missing finish"}}]}),
        json!({"error": {"message": "provider refusal"}}),
    ] {
        assert_eq!(
            assemble(&(event(&data) + done), 1024),
            Err(Failure::Invalid)
        );
    }
    let finished =
        event(&json!({"choices": [{"delta": {"content": "ok"}, "finish_reason": "stop"}]}));
    assert_eq!(assemble(&finished, 1024), Err(Failure::Invalid));
    assert!(assemble(&(finished + "data: [DONE]"), 1024).is_ok());
    let decoded = event(&json!({"choices": [{"delta": {
        "reasoning_content": "a".repeat(200), "content": "a".repeat(200)
    }, "finish_reason": "stop"}]}));
    assert_eq!(assemble(&(decoded + done), 300), Err(Failure::Invalid));
    let heartbeats = format!("{}{}", ":heartbeat\n".repeat(500), done);
    assert_eq!(assemble(&heartbeats, 100), Err(Failure::Invalid));
}

#[test]
fn stream_joins_multiline_events_and_enables_usage_without_removing_other_options() {
    let input =
        "data: {\"choices\":\r\ndata: [{\"finish_reason\":\"stop\"}]}\r\n\r\ndata: [DONE]\n\n";
    assert!(assemble(input, 1024).is_ok());
    let mut payload = Map::from_iter([
        ("stream_options".into(), json!({"other": true})),
        ("stream".into(), json!(false)),
    ]);
    stream_request(&mut payload).unwrap();
    assert_eq!(payload["stream"], true);
    assert_eq!(
        payload["stream_options"],
        json!({"other": true, "include_usage": true})
    );
}
