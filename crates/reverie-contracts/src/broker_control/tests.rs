use super::*;

// Each case is a C payload and the legacy handler's actual outcome, recorded
// by driving its handle() over a socketpair with only the effect owners
// stubbed (CPython 3.13.15, base worker.py). The reply column there is the
// stub's echo of the route and fields, or the E text.
fn text(value: &str) -> ControlField {
    ControlField::Text(value.into())
}
fn power(
    action: ControlField,
    caller: Option<ControlField>,
) -> Result<ControlRoute, ControlRefusal> {
    Ok(ControlRoute::Power { action, caller })
}
fn refused(message: &'static str) -> Result<ControlRoute, ControlRefusal> {
    Err(ControlRefusal::Message(message))
}

#[test]
fn power_requests() {
    assert_eq!(
        route(br#"{"action": "status"}"#),
        power(text("status"), None)
    );
    assert_eq!(
        route(br#"{"action": "status", "caller": null}"#),
        power(text("status"), None)
    );
    assert_eq!(
        route(br#"{"action": "restart-website", "caller": "s1"}"#),
        power(text("restart-website"), Some(text("s1")))
    );
    assert_eq!(
        route(br#"{"action": "provider-health"}"#),
        power(text("provider-health"), None)
    );
    assert_eq!(
        route(br#"{"action": 5}"#),
        power(ControlField::Integer("5".into()), None)
    );
    assert_eq!(
        route(br#"{"action": true}"#),
        power(ControlField::Other, None)
    );
}

#[test]
fn last_duplicate_key_wins() {
    assert_eq!(
        route(br#"{"action": "status", "action": "shutdown"}"#),
        power(text("shutdown"), None)
    );
}

#[test]
fn power_shape_refusals() {
    assert_eq!(
        route(br#"{"action": "status", "x": 1}"#),
        refused("Invalid office power request")
    );
    assert_eq!(route(b"[1]"), refused("Invalid office power request"));
    assert_eq!(
        route(br#""status""#),
        refused("Invalid office power request")
    );
    assert_eq!(
        route(br#"{"action": "provider-health", "x": 1}"#),
        refused("Closed read-only provider health request required")
    );
}

#[test]
fn legacy_transport_failures() {
    // A dict without "action" raises KeyError; an unhashable action raises
    // TypeError at the recovery-set check. Neither is a refusal.
    for raw in [
        &b"{}"[..],
        br#"{"caller": "x"}"#,
        br#"{"action": []}"#,
        br#"{"action": {}}"#,
    ] {
        assert_eq!(route(raw), Err(ControlRefusal::Transport), "{raw:?}");
    }
}

#[test]
fn recovery_routes() {
    assert_eq!(
        route(br#"{"action": "worker-resume-channel"}"#),
        Ok(ControlRoute::ResumeChannel)
    );
    assert_eq!(
        route(br#"{"action": "worker-resume-status"}"#),
        refused("Native host recovery requires its fixed owner channel")
    );
}

#[test]
fn perf_and_gpu_route_to_their_owners() {
    assert_eq!(
        route(br#"{"action": "perf-policy-status", "k": 1}"#),
        Ok(ControlRoute::PerfPolicy)
    );
    assert_eq!(
        route(br#"{"action": "gpu-access-request"}"#),
        Ok(ControlRoute::GpuAccess)
    );
}

#[test]
fn stop_shapes() {
    assert_eq!(
        route(br#"{"action": "settle-stop", "sessionId": "a", "fence": "f"}"#),
        Ok(ControlRoute::SettleStop {
            session: text("a"),
            fence: text("f")
        })
    );
    for raw in [
        &br#"{"action": "settle-stop", "sessionId": "a"}"#[..],
        br#"{"action": "settle-stop"}"#,
    ] {
        assert_eq!(route(raw), refused("Invalid settle-stop request"));
    }
    assert_eq!(
        route(br#"{"action": "stop-agent", "sessionId": "a"}"#),
        Ok(ControlRoute::StopAgent {
            session: text("a"),
            not_after: None,
            fence: None
        })
    );
    assert_eq!(
        route(br#"{"action": "stop-agent", "sessionId": "a", "notAfter": 5}"#),
        Ok(ControlRoute::StopAgent {
            session: text("a"),
            not_after: Some(ControlField::Integer("5".into())),
            fence: None
        })
    );
    assert_eq!(
        route(br#"{"action": "stop-agent", "sessionId": "a", "notAfter": 5, "fence": "f"}"#),
        Ok(ControlRoute::StopAgent {
            session: text("a"),
            not_after: Some(ControlField::Integer("5".into())),
            fence: Some(text("f"))
        })
    );
    assert_eq!(
        route(br#"{"action": "stop-agent", "sessionId": "a", "fence": "f"}"#),
        refused("Invalid stop-agent request")
    );
}

// The named difference (owner disposition): every undecodable payload is
// InvalidJson, whose E text is exactly UNDECODABLE_REFUSAL. The legacy texts
// these replace, from CPython 3.13.15 json.loads, are noted per case.
#[test]
fn undecodable_payloads_are_the_named_difference() {
    let cases: [(&[u8], &str); 5] = [
        (b"not json", "Expecting value: line 1 column 1 (char 0)"),
        (b"", "Expecting value: line 1 column 1 (char 0)"),
        (
            br#"{"action": "status""#,
            "Expecting ',' delimiter: line 1 column 20 (char 19)",
        ),
        (
            b"{\"action\": \"st\xffatus\"}",
            "'utf-8' codec can't decode byte 0xff in position 14",
        ),
        (
            b"\xff\xfe\x00",
            "'utf-16-le' codec can't decode byte 0x00 in position 2",
        ),
    ];
    for (raw, legacy) in cases {
        assert_eq!(route(raw), Err(ControlRefusal::InvalidJson), "{legacy}");
    }
    assert_eq!(UNDECODABLE_REFUSAL, "Invalid office power request");
}

// Parity, not the difference: json.loads(bytes) detects a BOM, so these decode.
#[test]
fn bom_prefixed_payloads_decode_like_python() {
    let mut utf8 = b"\xef\xbb\xbf".to_vec();
    utf8.extend_from_slice(br#"{"action": "status"}"#);
    assert_eq!(route(&utf8), power(text("status"), None));
    let mut utf16 = vec![0xff, 0xfe];
    for unit in r#"{"action": "status"}"#.encode_utf16() {
        utf16.extend_from_slice(&unit.to_le_bytes());
    }
    assert_eq!(route(&utf16), power(text("status"), None));
}
