use super::*;

fn text(reply: BrokerReply) -> String {
    String::from_utf8(reply.encode()).unwrap()
}

// Each expected string is the output of CPython's json.dumps on the same
// value (default separators, ensure_ascii=True, insertion order).
#[test]
fn status_reply_matches_python_default_dumps() {
    let reply = BrokerReply::object(vec![
        ("runningLaptops", BrokerReply::integer(2)),
        (
            "runningSessionIds",
            BrokerReply::array(vec![
                BrokerReply::string("0b0e8f3c-1111-4222-8333-944455556666"),
                BrokerReply::string("1c1f9a4d-aaaa-4bbb-8ccc-dddddddddddd"),
            ]),
        ),
        ("offlineGraceSeconds", BrokerReply::integer(600)),
    ]);
    assert_eq!(
        text(reply),
        r#"{"runningLaptops": 2, "runningSessionIds": ["0b0e8f3c-1111-4222-8333-944455556666", "1c1f9a4d-aaaa-4bbb-8ccc-dddddddddddd"], "offlineGraceSeconds": 600}"#
    );
}

#[test]
fn power_and_refusal_envelopes_match() {
    assert_eq!(
        text(BrokerReply::object(vec![
            ("action", BrokerReply::string("shutdown")),
            ("success", BrokerReply::boolean(true)),
        ])),
        r#"{"action": "shutdown", "success": true}"#
    );
    assert_eq!(
        text(BrokerReply::object(vec![
            ("action", BrokerReply::string("stop-agent")),
            ("success", BrokerReply::boolean(false)),
            ("dispatched", BrokerReply::boolean(false)),
            ("error", BrokerReply::null()),
        ])),
        r#"{"action": "stop-agent", "success": false, "dispatched": false, "error": null}"#
    );
}

#[test]
fn non_ascii_control_and_astral_text_is_escaped_like_python() {
    // CPython 3.13 json.dumps of the same text: e-acute and the emoji become
    // backslash-u escapes, the emoji as a surrogate pair. Built from a named
    // backslash so no escape sequence is interpreted in this source.
    let b = '\\';
    let expected = format!("\"{b}u00e9{b}n{b}t{b}\"{b}{b}{b}u0001{b}ud83d{b}ude00\"");
    let input = format!("{}\n\t\"\\{}{}", '\u{e9}', '\u{1}', '\u{1f600}');
    assert_eq!(text(BrokerReply::string(&input)), expected);
}

#[test]
fn empty_containers_and_negative_integers() {
    assert_eq!(text(BrokerReply::array(vec![])), "[]");
    assert_eq!(text(BrokerReply::object(vec![])), "{}");
    assert_eq!(text(BrokerReply::integer(-7)), "-7");
    assert_eq!(text(BrokerReply::integer(i64::MIN)), "-9223372036854775808");
}

#[test]
fn repeated_key_keeps_first_position_and_last_value() {
    // json.dumps({"a": 1, "b": 2, "a": 3}) == '{"a": 3, "b": 2}'
    assert_eq!(
        text(BrokerReply::object(vec![
            ("a", BrokerReply::integer(1)),
            ("b", BrokerReply::integer(2)),
            ("a", BrokerReply::integer(3)),
        ])),
        r#"{"a": 3, "b": 2}"#
    );
}
