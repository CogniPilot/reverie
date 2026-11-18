use super::{DISABLED, Phone, Poll, Start, decode, loopback_port};
use http::StatusCode;
use serde_json::json;

fn start(endpoint: &str, parent: &str) -> Start {
    Start {
        endpoint: Some(endpoint.into()),
        worker: Some("1".into()),
        session: Some("session-worker".into()),
        parent_session: Some(parent.into()),
    }
}

#[test]
fn phone_is_bound_to_the_configured_laptop_session_and_ipv4_loopback() {
    let endpoint = "http://127.0.0.1:8093/";
    assert!(Phone::bind(start(endpoint, "session-worker")).is_some());
    assert!(Phone::bind(start(endpoint, "another-session")).is_none());
    assert!(
        Phone::bind(Start {
            worker: None,
            ..start(endpoint, "session-worker")
        })
        .is_none()
    );
    for invalid in [
        "https://127.0.0.1:8093",
        "http://localhost:8093",
        "http://[::1]:8093",
        "http://user:password@127.0.0.1:8093",
        "http://127.0.0.1:0",
        "http://127.0.0.1:65536",
        "http://127.0.0.1:8093/path",
        "http://127.0.0.1:8093?query",
        "http://127.0.0.1:8093/#fragment",
    ] {
        assert!(loopback_port(invalid).is_none(), "{invalid}");
    }
}

#[test]
fn only_valid_metadata_on_a_successful_reply_can_wake_hands() {
    let status = StatusCode::OK;
    assert_eq!(
        decode(status, br#"{"success":true,"data":{"event":null}}"#),
        Some(Poll::Active(None))
    );
    assert!(matches!(
        decode(
            status,
            br#"{"success":true,"data":{"event":{"roomId":"room","messageId":"message"}}}"#
        ),
        Some(Poll::Active(Some(_)))
    ));
    for event in [
        json!({"roomId": "room", "messageId": "message", "text": "untrusted"}),
        json!({"roomId": "../escape", "messageId": "message"}),
        json!({"roomId": "room", "messageId": 1}),
        json!({"roomId": "room", "messageId": "a".repeat(201)}),
        json!({"roomId": "", "messageId": "message"}),
    ] {
        let response = json!({"success": true, "data": { "event": event }});
        assert_eq!(decode(status, response.to_string().as_bytes()), None);
    }
    assert_eq!(decode(status, br#"{"success":false,"data":{}}"#), None);
    assert_eq!(decode(status, br#"{"success":true,"data":null}"#), None);
}

#[test]
fn only_the_official_disabled_response_reports_an_office_policy_change() {
    let status = StatusCode::SERVICE_UNAVAILABLE;
    let reply = json!({"success": false, "error": DISABLED}).to_string();
    assert_eq!(decode(status, reply.as_bytes()), Some(Poll::Disabled));
    assert_eq!(decode(StatusCode::BAD_REQUEST, reply.as_bytes()), None);
    let reply = json!({"success": true, "error": DISABLED}).to_string();
    assert_eq!(decode(status, reply.as_bytes()), None);
    assert_eq!(
        decode(
            status,
            br#"{"success":false,"error":"private backend diagnostic"}"#
        ),
        None
    );
    assert_eq!(decode(status, b"private backend diagnostic"), None);
}
