use super::*;
const SID: &str = "11111111-1111-4111-8111-111111111111";
const PATH: &str = "/api/plans/requests/request/approve";
fn capability() -> Vec<u8> {
    format!(
        "{{\"requestId\":\"request\",\"sessionId\":\"{SID}\",\"nonce\":\"{}\"}}",
        "a".repeat(64)
    )
    .into_bytes()
}
#[test]
fn original_decision_wire_preserves_utf8_whitespace_and_only_attaches_bound_nonce() {
    let sid = ProfileSessionId::parse(SID).unwrap();
    let plan = PlanDecision::decode(
        "POST",
        PATH,
        false,
        "{\"handoff\":\"  UTC λ 😀\\t\\n \"}".as_bytes(),
    )
    .unwrap();
    let output = plan.attach_capability(&sid, &capability()).unwrap();
    assert_eq!(
        String::from_utf8(output).unwrap(),
        format!(
            "{{\"handoff\":\"  UTC λ 😀\\t\\n \",\"nonce\":\"{}\"}}",
            "a".repeat(64)
        )
    );
    let reject =
        PlanDecision::decode("POST", "/api/plans/requests/request/reject", false, b"{}").unwrap();
    assert_eq!(
        reject.attach_capability(&sid, &capability()).unwrap(),
        format!("{{\"nonce\":\"{}\"}}", "a".repeat(64)).into_bytes()
    );
}
#[test]
fn decision_refuses_forged_fields_duplicates_invalid_utf8_controls_and_wrong_route() {
    for body in [
        b"{}".as_slice(),
        b"[]",
        b"{\"handoff\":\"one\",\"handoff\":\"two\"}",
        b"{\"handoff\":\"Safe\",\"nonce\":\"forged\"}",
        b"{\"handoff\":\"\"}",
        b"{\"handoff\":\"\\u0000\"}",
        b"{\"handoff\":\"\\ud800\"}",
        b"\xff",
        b"\xef\xbb\xbf{\"handoff\":\"Safe\"}",
    ] {
        assert!(PlanDecision::decode("POST", PATH, false, body).is_err());
    }
    for (method, path, query) in [
        ("GET", PATH, false),
        ("POST", PATH, true),
        ("POST", "/api/plans/requests/../approve", false),
        ("POST", "/api/plans/requests/request/approve/extra", false),
    ] {
        assert!(PlanDecision::decode(method, path, query, b"{\"handoff\":\"Safe\"}").is_err());
    }
    assert!(
        PlanDecision::decode(
            "POST",
            PATH,
            false,
            format!("{{\"handoff\":\"{}\"}}", "x".repeat(12001)).as_bytes()
        )
        .is_err()
    );
}
#[test]
fn capability_rejects_wrong_session_request_nonce_extra_fields_and_duplicates() {
    let sid = ProfileSessionId::parse(SID).unwrap();
    let plan = PlanDecision::decode("POST", PATH, false, b"{\"handoff\":\"Safe\"}").unwrap();
    let raw = String::from_utf8(capability()).unwrap();
    for bad in [
        raw.replace(SID, "22222222-2222-4222-8222-222222222222"),
        raw.replace("requestId\":\"request", "requestId\":\"other"),
        raw.replace(&"a".repeat(64), &"A".repeat(64)),
        raw.replace("}", ",\"extra\":true}"),
        raw.replace("}", ",\"nonce\":\"forged\"}"),
    ] {
        assert!(plan.attach_capability(&sid, bad.as_bytes()).is_err());
    }
}
